// Bench-only static server for the grid-app build, with HTTP Range support so
// <video> seeking behaves like the app's asset protocol.
//
//   node scripts/bench/grid-app/serve.mjs <port> <dist dir> <preview mp4> <scenes json>
//
// /media/proxy.mp4 (any query) -> the preview file, /media/scenes.json -> the
// scene list, everything else -> the dist dir.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [port, distDir, proxyFile, scenesFile] = process.argv.slice(2);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".mp4": "video/mp4", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = types[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      let start = range[1] === "" ? st.size - Number(range[2]) : Number(range[1]);
      let end = range[1] !== "" && range[2] !== "" ? Number(range[2]) : st.size - 1;
      end = Math.min(end, st.size - 1);
      start = Math.max(0, start);
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1, "Accept-Ranges": "bytes" });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/media/proxy.mp4") return sendFile(req, res, proxyFile);
    if (url.pathname === "/media/scenes.json") return sendFile(req, res, scenesFile);
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.join(distDir, path.normalize(rel).replace(/^([/\\])+/, ""));
    if (!file.startsWith(path.resolve(distDir))) {
      res.writeHead(403);
      res.end();
      return;
    }
    sendFile(req, res, file);
  })
  .listen(Number(port), "127.0.0.1", () => console.log(`grid bench server on ${port}`));
