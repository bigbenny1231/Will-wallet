// Static server for site/ that applies site/vercel.json headers (CSP etc.), like Vercel does.
//   node design/serve.cjs site 8091
const http=require('http'),fs=require('fs'),path=require('path');
const root=process.argv[2], port=+process.argv[3]||8080;
const cfg=JSON.parse(fs.readFileSync(path.join(root,'vercel.json')));
const hdrs=cfg.headers[0].headers;
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.pdf':'application/pdf','.mp4':'video/mp4','.json':'application/json'};
http.createServer((req,res)=>{let u=decodeURIComponent(req.url.split('?')[0]);if(u.endsWith('/'))u+='index.html';let f=path.join(root,u);
 if(!fs.existsSync(f)&&fs.existsSync(f+'.html'))f+='.html';
 if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('nf');}
 hdrs.forEach(h=>res.setHeader(h.key,h.value));res.setHeader('Content-Type',types[path.extname(f)]||'application/octet-stream');
 const st=fs.statSync(f);const range=req.headers.range;
 if(range){const [s,e]=range.replace('bytes=','').split('-');const start=+s,end=e?+e:st.size-1;res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${st.size}`,'Accept-Ranges':'bytes','Content-Length':end-start+1});return fs.createReadStream(f,{start,end}).pipe(res);}
 res.setHeader('Content-Length',st.size);res.writeHead(200);fs.createReadStream(f).pipe(res);}).listen(port,()=>console.log('serving',root,port));
