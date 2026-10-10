'use strict';

(() => {
  function parseAttributes(value = '') {
    const result = {};
    let token = '';
    let quoted = false;
    const fields = [];
    for (const character of String(value)) {
      if (character === '"') quoted = !quoted;
      if (character === ',' && !quoted) {
        fields.push(token);
        token = '';
      } else {
        token += character;
      }
    }
    if (token) fields.push(token);
    for (const field of fields) {
      const separator = field.indexOf('=');
      if (separator < 0) continue;
      const key = field.slice(0, separator).trim().toUpperCase();
      let fieldValue = field.slice(separator + 1).trim();
      if (fieldValue.startsWith('"') && fieldValue.endsWith('"')) fieldValue = fieldValue.slice(1, -1);
      result[key] = fieldValue;
    }
    return result;
  }

  function absoluteUrl(value, baseUrl) {
    const url = new URL(String(value || ''), baseUrl);
    if (!['file:', 'http:', 'https:'].includes(url.protocol)) throw new Error(`HLS 包含不受支持的 URL：${url.protocol}`);
    return url.href;
  }

  // Byte ranges address one finite part of a larger resource. Missing offsets
  // may only continue the immediately previous range on the *same* URI.
  function parseByteRange(value, prior = null, url = '') {
    const match = String(value || '').trim().match(/^(\d+)(?:@(\d+))?$/);
    if (!match) throw new Error('HLS BYTERANGE 长度/偏移格式无效');
    const length = Number(match[1]);
    const offset = match[2] === undefined
      ? (prior?.url === url ? prior.offset + prior.length : NaN) : Number(match[2]);
    if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(offset + length - 1)) throw new Error('HLS BYTERANGE 缺少同 URI 连续偏移或超出安全整数范围');
    return { offset, length, url };
  }

  function parsePlaylist(text, playlistUrl) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U') throw new Error('不是有效的 HLS m3u8 清单');
    const variants = [];
    const audioRenditions = [];
    const segments = [];
    let streamInfo = null;
    let duration = 0;
    let mediaSequence = 0;
    let nextSequence = 0;
    let key = null;
    let initMap = null;
    let unsupportedByteRange = false;
    let pendingByteRange = null;
    let previousByteRange = null;
    let endList = false;
    let discontinuity = 0;
    let timeline = 0;
    let contextGroup = 0;
    let lastContext = null;

    for (const line of lines.slice(1)) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        streamInfo = parseAttributes(line.slice(line.indexOf(':') + 1));
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const attributes = parseAttributes(line.slice(line.indexOf(':') + 1));
        if (attributes.TYPE === 'AUDIO' && attributes.URI) {
          audioRenditions.push({
            url: absoluteUrl(attributes.URI, playlistUrl),
            default: attributes.DEFAULT === 'YES',
            autoselect: attributes.AUTOSELECT === 'YES',
            language: attributes.LANGUAGE || '',
            groupId: attributes['GROUP-ID'] || '',
            name: attributes.NAME || ''
          });
        }
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = Math.max(0, Number(line.split(':')[1]) || 0);
        nextSequence = mediaSequence;
      } else if (line.startsWith('#EXTINF:')) {
        duration = Math.max(0, Number(line.slice(line.indexOf(':') + 1).split(',')[0]) || 0);
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const attributes = parseAttributes(line.slice(line.indexOf(':') + 1));
        const method = String(attributes.METHOD || '').toUpperCase();
        if (!method || method === 'NONE') key = null;
        else if (method === 'AES-128' && attributes.URI && (!attributes.KEYFORMAT || attributes.KEYFORMAT === 'identity')) {
          key = { method, url: absoluteUrl(attributes.URI, playlistUrl), iv: attributes.IV || '' };
        } else {
          throw new Error(`当前纯浏览器版不支持 HLS 加密方式 ${method || '未知'}`);
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const attributes = parseAttributes(line.slice(line.indexOf(':') + 1));
        if (attributes.URI) {
          const mapUrl = absoluteUrl(attributes.URI, playlistUrl);
          // EXT-X-MAP BYTERANGE does not inherit the media segment offset.
          const mapRange = attributes.BYTERANGE ? parseByteRange(attributes.BYTERANGE, null, mapUrl) : null;
          initMap = { url: mapUrl, range: mapRange, key: key ? { ...key } : null };
        }
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingByteRange = line.slice(line.indexOf(':') + 1).trim();
      } else if (line === '#EXT-X-DISCONTINUITY') {
        discontinuity += 1;
      } else if (line === '#EXT-X-ENDLIST') {
        endList = true;
      } else if (!line.startsWith('#')) {
        const url = absoluteUrl(line, playlistUrl);
        if (streamInfo) {
          variants.push({
            url,
            bandwidth: Number(streamInfo.BANDWIDTH) || 0,
            codecs: streamInfo.CODECS || '',
            audioGroup: streamInfo.AUDIO || ''
          });
          streamInfo = null;
        } else {
          // Precompute the init-map/discontinuity group once per playlist.
          // HLS window planning must not stringify this context for each seek.
          const context = JSON.stringify([discontinuity, initMap?.url || '',
            initMap?.range?.offset ?? null, initMap?.range?.length ?? null,
            initMap?.key?.url || '', initMap?.key?.iv || '']);
          if (context !== lastContext) { contextGroup += 1; lastContext = context; }
          const range = pendingByteRange ? parseByteRange(pendingByteRange, previousByteRange, url) : null;
          previousByteRange = range;
          pendingByteRange = null;
          segments.push({ url, range, duration, sequence: nextSequence++, key: key ? { ...key } : null,
            initMap: initMap ? { ...initMap } : null, discontinuity, contextGroup,
            start: timeline, end: timeline + duration });
          timeline += duration;
          duration = 0;
        }
      }
    }

    if (pendingByteRange) throw new Error('HLS BYTERANGE 标记没有对应媒体 URI');
    return {
      playlistUrl,
      master: variants.length > 0 || audioRenditions.length > 0,
      variants,
      audioRenditions,
      segments,
      mediaSequence,
      initMap,
      unsupportedByteRange,
      endList
    };
  }

  function planWindow(segments, time, seconds = 30) {
    const target = Math.max(0, Number(time) || 0);
    // Segment end times are monotonic. Rolling lookahead calls this repeatedly,
    // so a linear findIndex makes a 10k-segment HLS VOD pay O(n) for every
    // window. Binary search keeps seeks/prefetch planning O(log n).
    let low = 0;
    let high = segments.length;
    const threshold = target + 0.025;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (Number(segments[middle].end) <= threshold) low = middle + 1;
      else high = middle;
    }
    let at = low;
    if (at >= segments.length) return null;
    const sameContext = (a, b) => Number.isInteger(a.contextGroup) && Number.isInteger(b.contextGroup)
      ? a.contextGroup === b.contextGroup
      : JSON.stringify([a.discontinuity || 0, a.initMap?.url || '', a.initMap?.range?.offset ?? null, a.initMap?.range?.length ?? null, a.initMap?.key?.url || '', a.initMap?.key?.iv || '']) ===
        JSON.stringify([b.discontinuity || 0, b.initMap?.url || '', b.initMap?.range?.offset ?? null, b.initMap?.range?.length ?? null, b.initMap?.key?.url || '', b.initMap?.key?.iv || '']);
    if (at > 0 && sameContext(segments[at - 1], segments[at])) at -= 1;
    let end = at + 1;
    const until = target + Math.max(1, Number(seconds) || 30);
    while (end < segments.length && segments[end - 1].end < until && sameContext(segments[end], segments[at])) end += 1;
    return { from: at, to: end, start: segments[at].start, end: segments[end - 1].end,
      requestedTime: target, complete: end === segments.length };
  }

  function readSection(payload, payloadUnitStart) {
    let offset = 0;
    if (payloadUnitStart) {
      const pointer = payload[0] || 0;
      offset = 1 + pointer;
    }
    if (offset + 3 > payload.length) return null;
    const sectionLength = ((payload[offset + 1] & 0x0f) << 8) | payload[offset + 2];
    const end = offset + 3 + sectionLength;
    return end <= payload.length ? payload.subarray(offset, end) : null;
  }

  class TsAudioDemuxer {
    constructor() {
      this.pmtPid = -1;
      this.audioPid = -1;
      this.audioType = 0;
      this.pesRemaining = Infinity;
      this.chunks = [];
      this.total = 0;
    }

    parsePat(payload, start) {
      const section = readSection(payload, start);
      if (!section || section[0] !== 0x00 || section.length < 12) return;
      for (let offset = 8; offset + 4 <= section.length - 4; offset += 4) {
        const program = (section[offset] << 8) | section[offset + 1];
        if (program) {
          this.pmtPid = ((section[offset + 2] & 0x1f) << 8) | section[offset + 3];
          return;
        }
      }
    }

    parsePmt(payload, start) {
      const section = readSection(payload, start);
      if (!section || section[0] !== 0x02 || section.length < 16) return;
      const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
      let offset = 12 + programInfoLength;
      const supported = new Map([[0x0f, 4], [0x03, 3], [0x04, 3], [0x11, 1]]);
      let best = null;
      while (offset + 5 <= section.length - 4) {
        const streamType = section[offset];
        const pid = ((section[offset + 1] & 0x1f) << 8) | section[offset + 2];
        const infoLength = ((section[offset + 3] & 0x0f) << 8) | section[offset + 4];
        const priority = supported.get(streamType) || 0;
        if (priority && (!best || priority > best.priority)) best = { pid, streamType, priority };
        offset += 5 + infoLength;
      }
      if (best) {
        this.audioPid = best.pid;
        this.audioType = best.streamType;
      }
    }

    append(bytes) {
      if (!bytes.length) return;
      this.chunks.push(bytes.slice());
      this.total += bytes.length;
    }

    parseAudio(payload, start) {
      let offset = 0;
      if (start) {
        if (payload.length < 9 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) return;
        const pesLength = (payload[4] << 8) | payload[5];
        const headerLength = payload[8];
        offset = Math.min(payload.length, 9 + headerLength);
        this.pesRemaining = pesLength ? Math.max(0, pesLength - 3 - headerLength) : Infinity;
      }
      const available = Math.max(0, payload.length - offset);
      const take = Number.isFinite(this.pesRemaining) ? Math.min(available, this.pesRemaining) : available;
      if (take > 0) this.append(payload.subarray(offset, offset + take));
      if (Number.isFinite(this.pesRemaining)) this.pesRemaining = Math.max(0, this.pesRemaining - take);
    }

    feed(bytes) {
      let startOffset = 0;
      while (startOffset < Math.min(188, bytes.length) && !(
        bytes[startOffset] === 0x47 && bytes[startOffset + 188] === 0x47 && bytes[startOffset + 376] === 0x47
      )) startOffset += 1;
      if (startOffset >= Math.min(188, bytes.length)) throw new Error('HLS 分片不是 188 字节 MPEG-TS');

      for (let packetOffset = startOffset; packetOffset + 188 <= bytes.length; packetOffset += 188) {
        if (bytes[packetOffset] !== 0x47) continue;
        const start = Boolean(bytes[packetOffset + 1] & 0x40);
        const pid = ((bytes[packetOffset + 1] & 0x1f) << 8) | bytes[packetOffset + 2];
        const adaptation = (bytes[packetOffset + 3] >> 4) & 0x03;
        if (adaptation === 0 || adaptation === 2) continue;
        let payloadOffset = packetOffset + 4;
        if (adaptation === 3) payloadOffset += 1 + bytes[payloadOffset];
        const packetEnd = packetOffset + 188;
        if (payloadOffset >= packetEnd) continue;
        const payload = bytes.subarray(payloadOffset, packetEnd);
        if (pid === 0) this.parsePat(payload, start);
        else if (pid === this.pmtPid) this.parsePmt(payload, start);
        else if (pid === this.audioPid) this.parseAudio(payload, start);
      }
    }

    finish() {
      if (this.audioPid < 0) throw new Error('MPEG-TS 中没有找到 AAC/MP3 音轨');
      if (this.audioType === 0x11) throw new Error('检测到 AAC-LATM；当前浏览器解码器只支持 HLS ADTS AAC/MP3');
      const output = new Uint8Array(this.total);
      let offset = 0;
      for (const chunk of this.chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      if (!output.length) throw new Error('MPEG-TS 音轨为空');
      return { buffer: output.buffer, codec: this.audioType === 0x0f ? 'adts' : 'mpeg-audio' };
    }
  }

  function sequenceIv(sequence) {
    const iv = new Uint8Array(16);
    let value = BigInt(Math.max(0, Number(sequence) || 0));
    for (let index = 15; index >= 0; index -= 1) {
      iv[index] = Number(value & 0xffn);
      value >>= 8n;
    }
    return iv;
  }

  function parseIv(value, sequence) {
    if (!value) return sequenceIv(sequence);
    const hex = String(value).replace(/^0x/i, '').padStart(32, '0');
    if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('HLS AES-128 IV 无效');
    return Uint8Array.from({ length: 16 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16));
  }

  self.BrowserHls = Object.freeze({ parsePlaylist, planWindow, parseIv, TsAudioDemuxer });
})();
