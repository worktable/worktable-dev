import http from 'node:http';
import net from 'node:net';

// A loopback-only audit proxy restricted to one isolated HTTP fixture origin.
// Unlike per-target CDP throttling, this also covers sandboxed iframe document
// requests. Responses share a single download budget; each request incurs the
// configured latency. WebSocket bytes pass through after the delayed handshake:
// use this for HTML delivery diagnostics, not Yjs throughput claims.
export async function startThrottledFixtureProxy(origin, {
  latency = 400, downloadThroughput = 200000, uploadThroughput = 93750,
} = {}) {
  const target = new URL(origin);
  if (target.protocol !== 'http:') throw new Error('Only isolated HTTP fixtures are supported');
  const jobs = [], sockets = new Set(), timers = new Set();
  const agent = new http.Agent({keepAlive:true,maxSockets:6});
  let cursor = 0;
  const schedule = (callback, milliseconds) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds);
    timers.add(timer);
  };
  const tick = setInterval(() => {
    if (!jobs.length) return;
    cursor %= jobs.length;
    const job = jobs[cursor];
    if (job.response.destroyed) { jobs.splice(cursor,1); return; }
    let budget = Math.max(1, Math.floor(downloadThroughput / 100));
    while (budget && job.chunks.length) {
      const chunk = job.chunks[0], bytes = Math.min(budget,chunk.length-job.offset);
      job.response.write(chunk.subarray(job.offset,job.offset+bytes));
      job.offset += bytes; budget -= bytes;
      if (job.offset === chunk.length) { job.chunks.shift(); job.offset=0; }
    }
    if (job.ended && !job.chunks.length) { job.response.end(); jobs.splice(cursor,1); }
    else cursor++;
  },10);
  const requestUrl = request => new URL(request.url, origin);
  const server = http.createServer((request,response) => {
    const url = requestUrl(request);
    if (url.origin !== target.origin) { response.writeHead(403).end(); return; }
    const body=[]; request.on('data',chunk=>body.push(chunk));
    request.on('end',()=>{
      const bytes=Buffer.concat(body);
      schedule(()=>{
        if(response.destroyed)return;
        const headers={...request.headers}; delete headers['proxy-connection']; delete headers.connection;
        const upstream=http.request(url,{method:request.method,headers,agent},incoming=>{
          response.writeHead(incoming.statusCode,incoming.headers);
          const job={response,chunks:[],offset:0,ended:false};jobs.push(job);
          incoming.on('data',chunk=>job.chunks.push(chunk));incoming.on('end',()=>{job.ended=true});
          incoming.on('error',()=>response.destroy());response.on('close',()=>incoming.destroy());
        });
        upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end()});
        upstream.end(bytes);
      },latency+bytes.length/uploadThroughput*1000);
    });
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))});
  server.on('upgrade',(request,socket,head)=>{
    const url=requestUrl(request);if(url.hostname!==target.hostname||url.port!==target.port){socket.destroy();return;}
    schedule(()=>{
      if(socket.destroyed)return;
      const upstream=net.connect(Number(target.port)||80,target.hostname,()=>{
        upstream.write(`${request.method} ${url.pathname+url.search} HTTP/${request.httpVersion}\r\n${request.rawHeaders.reduce((lines,value,index,all)=>index%2?lines:lines+value+': '+all[index+1]+'\r\n','')}\r\n`);
        if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
      });
      sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());
    },latency);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,close:async()=>{
    clearInterval(tick);for(const timer of timers)clearTimeout(timer);for(const socket of sockets)socket.destroy();agent.destroy();await new Promise(resolve=>server.close(resolve));
  }};
}
