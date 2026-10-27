const IMA_INDEX_TABLE = [
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8,
]

const IMA_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544,
  598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707,
  1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871,
  5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635,
  13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]

function sfxError(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw sfxError('INVALID_AUDIO_DATA', '音频数据格式无效')
}

function crc16Arc(value) {
  const bytes = toBytes(value)
  let crc = 0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1)
    }
  }
  return crc & 0xffff
}

function crc32Ieee(value) {
  const bytes = toBytes(value)
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildDataFrame(sequence, payload, packetType = 0xa0) {
  const body = toBytes(payload)
  if (body.length > 0xffff) throw sfxError('SFX_FRAME_TOO_LARGE', '音效数据帧过长')
  const frame = new Uint8Array(6 + body.length)
  const view = new DataView(frame.buffer)
  frame[0] = packetType & 0xff
  frame[1] = sequence & 0xff
  view.setUint16(2, body.length, true)
  frame.set(body, 4)
  view.setUint16(4 + body.length, crc16Arc(frame.slice(1, 4 + body.length)), true)
  return frame
}

function splitDataFrames(payload, mtu = 20, packetType = 0xa0) {
  const bytes = toBytes(payload)
  const negotiatedMtu = Math.max(20, Math.min(512, Number(mtu) || 20))
  const payloadBytes = Math.max(1, Math.min(497, negotiatedMtu - 9))
  const frames = []
  for (let offset = 0, sequence = 0; offset < bytes.length; offset += payloadBytes, sequence += 1) {
    frames.push({
      index: frames.length,
      sequence: sequence & 0xff,
      frame: buildDataFrame(sequence, bytes.slice(offset, Math.min(bytes.length, offset + payloadBytes)), packetType),
    })
  }
  return frames
}

function readAscii(view, offset, length) {
  let text = ''
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(view.getUint8(offset + index))
  return text
}

function decodeWav(value) {
  const bytes = toBytes(value)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 44 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw sfxError('INVALID_WAV', '请选择标准 WAV 文件')
  }
  let format = null
  let dataOffset = -1
  let dataLength = 0
  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4)
    const chunkLength = view.getUint32(offset + 4, true)
    const bodyOffset = offset + 8
    if (bodyOffset + chunkLength > view.byteLength) throw sfxError('INVALID_WAV', 'WAV 文件块长度无效')
    if (chunkId === 'fmt ' && chunkLength >= 16) {
      format = {
        tag: view.getUint16(bodyOffset, true),
        channels: view.getUint16(bodyOffset + 2, true),
        sampleRate: view.getUint32(bodyOffset + 4, true),
        blockAlign: view.getUint16(bodyOffset + 12, true),
        bitsPerSample: view.getUint16(bodyOffset + 14, true),
      }
    } else if (chunkId === 'data') {
      dataOffset = bodyOffset
      dataLength = chunkLength
    }
    offset = bodyOffset + chunkLength + (chunkLength & 1)
  }
  if (!format || dataOffset < 0 || !format.channels || !format.sampleRate || !format.blockAlign) {
    throw sfxError('INVALID_WAV', 'WAV 文件缺少音频格式或数据块')
  }
  if (![1, 3].includes(format.tag)) throw sfxError('UNSUPPORTED_WAV', '仅支持 PCM 或 IEEE Float WAV')
  if (![8, 16, 24, 32].includes(format.bitsPerSample)) {
    throw sfxError('UNSUPPORTED_WAV', '仅支持 8/16/24/32 位 WAV')
  }
  if (format.tag === 3 && format.bitsPerSample !== 32) {
    throw sfxError('UNSUPPORTED_WAV', '浮点 WAV 必须是 32 位')
  }
  const frameCount = Math.floor(dataLength / format.blockAlign)
  const mono = new Float32Array(frameCount)
  const bytesPerSample = format.bitsPerSample / 8
  for (let frame = 0; frame < frameCount; frame += 1) {
    let mixed = 0
    for (let channel = 0; channel < format.channels; channel += 1) {
      const sampleOffset = dataOffset + frame * format.blockAlign + channel * bytesPerSample
      mixed += readSample(view, sampleOffset, format.tag, format.bitsPerSample)
    }
    mono[frame] = Math.max(-1, Math.min(1, mixed / format.channels))
  }
  return { samples: mono, sampleRate: format.sampleRate }
}

function readSample(view, offset, tag, bits) {
  if (tag === 3) return view.getFloat32(offset, true)
  if (bits === 8) return (view.getUint8(offset) - 128) / 128
  if (bits === 16) return view.getInt16(offset, true) / 32768
  if (bits === 24) {
    let value = view.getUint8(offset)
      | (view.getUint8(offset + 1) << 8)
      | (view.getUint8(offset + 2) << 16)
    if (value & 0x800000) value |= 0xff000000
    return value / 8388608
  }
  return view.getInt32(offset, true) / 2147483648
}

function resampleLinear(samples, sourceRate, targetRate = 16000) {
  if (sourceRate === targetRate) return new Float32Array(samples)
  const outputLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate))
  const output = new Float32Array(outputLength)
  const scale = sourceRate / targetRate
  for (let index = 0; index < outputLength; index += 1) {
    const source = index * scale
    const left = Math.min(samples.length - 1, Math.floor(source))
    const right = Math.min(samples.length - 1, left + 1)
    const fraction = source - left
    output[index] = samples[left] + (samples[right] - samples[left]) * fraction
  }
  return output
}

function encodeImaAdpcm(samples) {
  if (!samples || !samples.length) throw sfxError('EMPTY_AUDIO', 'WAV 文件没有可编码的采样')
  const samplesPerBlock = 505
  const blockCount = Math.ceil(samples.length / samplesPerBlock)
  const output = new Uint8Array(blockCount * 256)
  let stepIndex = 0
  for (let block = 0; block < blockCount; block += 1) {
    const sampleOffset = block * samplesPerBlock
    const outputOffset = block * 256
    let predictor = toInt16(samples[sampleOffset])
    const view = new DataView(output.buffer)
    view.setInt16(outputOffset, predictor, true)
    output[outputOffset + 2] = stepIndex
    output[outputOffset + 3] = 0
    for (let nibbleIndex = 0; nibbleIndex < 504; nibbleIndex += 1) {
      const sourceIndex = sampleOffset + nibbleIndex + 1
      const target = sourceIndex < samples.length ? toInt16(samples[sourceIndex]) : predictor
      const encoded = encodeNibble(target, predictor, stepIndex)
      predictor = encoded.predictor
      stepIndex = encoded.stepIndex
      const byteOffset = outputOffset + 4 + (nibbleIndex >>> 1)
      if ((nibbleIndex & 1) === 0) output[byteOffset] = encoded.code
      else output[byteOffset] |= encoded.code << 4
    }
  }
  return output
}

function toInt16(sample) {
  return Math.max(-32768, Math.min(32767, Math.round(Number(sample || 0) * 32767)))
}

function encodeNibble(target, predictor, stepIndex) {
  const step = IMA_STEP_TABLE[stepIndex]
  let difference = target - predictor
  let code = 0
  if (difference < 0) {
    code = 8
    difference = -difference
  }
  let delta = step >>> 3
  if (difference >= step) {
    code |= 4
    difference -= step
    delta += step
  }
  if (difference >= (step >>> 1)) {
    code |= 2
    difference -= step >>> 1
    delta += step >>> 1
  }
  if (difference >= (step >>> 2)) {
    code |= 1
    delta += step >>> 2
  }
  predictor += (code & 8) ? -delta : delta
  predictor = Math.max(-32768, Math.min(32767, predictor))
  stepIndex = Math.max(0, Math.min(88, stepIndex + IMA_INDEX_TABLE[code]))
  return { code, predictor, stepIndex }
}

function prepareWavUpload(name, wavData) {
  const normalizedName = String(name || '').replace(/\.wav$/i, '')
  if (!/^[0-9A-Za-z_-]{1,24}$/.test(normalizedName)) {
    throw sfxError('INVALID_SFX_NAME', '音效名称仅支持 1-24 位字母、数字、下划线或连字符')
  }
  const decoded = decodeWav(wavData)
  const samples = resampleLinear(decoded.samples, decoded.sampleRate, 16000)
  const payload = encodeImaAdpcm(samples)
  return {
    name: normalizedName,
    format: 1,
    payload,
    size: payload.length,
    crc32: crc32Ieee(payload),
    sampleRate: 16000,
    durationSeconds: samples.length / 16000,
  }
}

module.exports = {
  buildDataFrame,
  crc16Arc,
  crc32Ieee,
  decodeWav,
  encodeImaAdpcm,
  prepareWavUpload,
  resampleLinear,
  splitDataFrames,
}
