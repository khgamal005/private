const ESCAPE_PREFIX = '~marktone-jsonb-escape-v1~';

function encodeString(value, diagnostics) {
  let requiresEncoding = value.startsWith(ESCAPE_PREFIX);
  let unsupportedCodeUnits = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) {
      requiresEncoding = true;
      unsupportedCodeUnits += 1;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      } else {
        requiresEncoding = true;
        unsupportedCodeUnits += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      requiresEncoding = true;
      unsupportedCodeUnits += 1;
    }
  }
  if (!requiresEncoding) return value;

  let encoded = ESCAPE_PREFIX;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (value[index] === '\\') {
      encoded += '\\\\';
      continue;
    }
    if (code === 0) {
      encoded += '\\u0000';
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        encoded += value[index] + value[index + 1];
        index += 1;
      } else {
        encoded += `\\u${code.toString(16).padStart(4, '0')}`;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      encoded += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    encoded += value[index];
  }
  diagnostics.encodedStrings += 1;
  diagnostics.unsupportedCodeUnits += unsupportedCodeUnits;
  return encoded;
}

function encodeValue(value, diagnostics) {
  if (typeof value === 'string') return encodeString(value, diagnostics);
  if (Array.isArray(value)) {
    return value.map(item => encodeValue(item, diagnostics));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    encodeString(key, diagnostics),
    encodeValue(item, diagnostics)
  ]));
}

function decodeString(value) {
  if (!value.startsWith(ESCAPE_PREFIX)) return value;
  const encoded = value.slice(ESCAPE_PREFIX.length);
  let decoded = '';
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] !== '\\') {
      decoded += encoded[index];
      continue;
    }
    if (encoded[index + 1] === '\\') {
      decoded += '\\';
      index += 1;
      continue;
    }
    const unicode = /^u([0-9a-f]{4})/i.exec(encoded.slice(index + 1));
    if (unicode) {
      decoded += String.fromCharCode(Number.parseInt(unicode[1], 16));
      index += 5;
      continue;
    }
    decoded += '\\';
  }
  return decoded;
}

export function restoreWooJsonbValue(value) {
  if (typeof value === 'string') return decodeString(value);
  if (Array.isArray(value)) return value.map(restoreWooJsonbValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    decodeString(key),
    restoreWooJsonbValue(item)
  ]));
}

export function prepareWooJsonbItem(item) {
  const diagnostics = {encodedStrings: 0, unsupportedCodeUnits: 0};
  const encoded = encodeValue(item, diagnostics);
  if (!diagnostics.encodedStrings) return encoded;
  if (
    encoded._marktone !== undefined
    && (
      !encoded._marktone
      || typeof encoded._marktone !== 'object'
      || Array.isArray(encoded._marktone)
    )
  ) {
    return encoded;
  }
  const markettone = encoded._marktone
    && typeof encoded._marktone === 'object'
    && !Array.isArray(encoded._marktone)
    ? encoded._marktone
    : {};
  return {
    ...encoded,
    _marktone: {
      ...markettone,
      jsonbEncoding: {
        codec: 'marktone-jsonb-escape-v1',
        encodedStrings: diagnostics.encodedStrings,
        unsupportedCodeUnits: diagnostics.unsupportedCodeUnits
      }
    }
  };
}

export function prepareWooJsonbItems(items) {
  return items.map(prepareWooJsonbItem);
}
