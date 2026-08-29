'use strict';

function sendAudioBufferResponse({ req, res, buffer, mimeType }) {
  const totalSize = buffer.length;
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const requestedStart = match?.[1] ? Number.parseInt(match[1], 10) : 0;
    const requestedEnd = match?.[2]
      ? Number.parseInt(match[2], 10)
      : totalSize - 1;
    const start = Math.max(0, Math.min(requestedStart, totalSize - 1));
    const end = Math.max(start, Math.min(requestedEnd, totalSize - 1));
    const chunk = buffer.subarray(start, end + 1);

    res.status(206);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(chunk.length));
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.send(chunk);
    return;
  }

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(totalSize));
  res.send(buffer);
}

module.exports = {
  sendAudioBufferResponse,
};
