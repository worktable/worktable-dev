import base from '../../../apps/web/vite.config'
import {defineConfig,mergeConfig} from 'vite'
const mode=process.env.LOADING_EXPERIMENT||'editor'
export default defineConfig(mergeConfig(base,{
 plugins:[{
  name:'isolated-loading-experiment',enforce:'pre',
  transform(code,id){
   if(mode==='editor'&&id.endsWith('/components/editor/editor.tsx')){
    const start=code.indexOf('function AnnotationBadges(')
    const before=code.slice(0,start),body=code.slice(start)
    return before+body.replace('  useEffect(() => {\n    const update = () => {','  useEffect(() => {\n    if (!annotations.some(a => a.status !== "resolved" && "blockId" in a.target && a.target.blockId)) { setPositions(previous => previous.length ? [] : previous); return; }\n    const update = () => {')
   }
   if(mode==='editor'&&id.includes('/@blocknote/core/dist/blocks-')&&id.endsWith('.js')){
    if(!code.includes('let o = t.getBlock(a);'))throw Error('Unexpected BlockNote implementation')
    return code.replace('let o = t.getBlock(a);','let o = L(n.state.doc.resolve(i).node(), n.state.doc.type.schema);')
   }
   if(mode==='shell'&&id.endsWith('/routes/__root.tsx')){
    return code.replace('import { AppSidebar } from "@/components/app-sidebar"','import { lazy, Suspense } from "react"\nconst AppSidebar = lazy(() => import("@/components/app-sidebar").then(m => ({default: m.AppSidebar})))')
     .replace('import { Onboarding } from "@/components/onboarding/onboarding"','const Onboarding = lazy(() => import("@/components/onboarding/onboarding").then(m => ({default: m.Onboarding})))')
     .replaceAll('<AppSidebar />','<Suspense fallback={null}><AppSidebar /></Suspense>')
     .replace('<Onboarding workspace={workspace} />','<Suspense fallback={<InitialLoader />}><Onboarding workspace={workspace} /></Suspense>')
   }
  }
 }],build:{outDir:'/tmp/worktable-'+mode+'-prototype',sourcemap:true}
}))
