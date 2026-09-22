import {createElement} from "react";
import {renderToStaticMarkup} from 'react-dom/server';
import {DocumentPreview} from '../../../apps/web/src/components/editor/document-preview';
import {readFile} from 'node:fs/promises';
const cfg=JSON.parse(await readFile(process.env.AUDIT_CONFIG || '/tmp/worktable-review.json','utf8'));
const server=Bun.serve({hostname:'127.0.0.1',port:Number(process.env.READER_PORT || 45551),async fetch(request){
 const url=new URL(request.url);const path=url.pathname.slice(1);if(!['rich-10','rich-2000','rich-500'].includes(path))return new Response('Unknown fixture',{status:404});
 const pageResponse=await fetch(cfg.apiUrl+'/api/spaces/loading-audit/documents/page?path='+path);if(!pageResponse.ok)return new Response('Unavailable',{status:pageResponse.status});const {page}=await pageResponse.json();if(page.kind!=='document'||page.document.path!==path)return new Response('Identity mismatch',{status:409});
 const response=await fetch(cfg.apiUrl+'/api/spaces/loading-audit/docs/'+path+'?conversionCheck=skip');if(!response.ok)return new Response('Unavailable',{status:response.status});const doc=await response.json();
 const content=doc.content??doc.doc?.content;if(!content)throw Error('Missing content: '+Object.keys(doc));
 const body=renderToStaticMarkup(createElement(DocumentPreview,{content})).replace('Saved preview · Opening editor…','Read-only architecture prototype · Editor is not loaded').replace('More content is opening…','This experiment shows the first 80 blocks.');
 return new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Document-first reading prototype</title><style>html{background:#0b0c0d;color:#ddd;font:16px/1.65 system-ui}body{margin:0}article{max-width:740px;padding:32px;margin:auto}[role=status]{font-size:12px;color:#999;margin-bottom:24px}p{margin:0 0 14px}</style><body>'+body+'</body></html>',{headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'}});
}});console.log('Reader prototype: http://127.0.0.1:'+server.port);await Bun.write('/tmp/worktable-reader-proof.json',JSON.stringify({origin:'http://127.0.0.1:'+server.port}));
