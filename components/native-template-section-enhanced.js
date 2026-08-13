'use client';

import {useEffect,useRef,useState} from 'react';
import NativeTemplateSection from './native-template-section';
import {activateSafeTemplateEffects} from './native-template-safe-effects';

const SAFE_MOTION_CSS=`
:host [data-marktone-native-reveal="true"],
:host .dashboard{
  opacity:0!important;
  visibility:visible!important;
  transform:translate3d(0,22px,0)!important;
  filter:blur(4px)!important;
  transition:opacity .65s cubic-bezier(.2,.7,.2,1),transform .65s cubic-bezier(.2,.7,.2,1),filter .65s ease!important;
  will-change:opacity,transform,filter;
}
:host [data-marktone-native-reveal="true"].in-view,
:host [data-marktone-native-reveal="true"].aos-animate,
:host [data-marktone-native-reveal="true"].is-visible,
:host .dashboard.in-view{
  opacity:1!important;
  transform:none!important;
  filter:none!important;
}
@media(prefers-reduced-motion:reduce){
  :host [data-marktone-native-reveal="true"],:host .dashboard{
    opacity:1!important;transform:none!important;filter:none!important;transition:none!important;
  }
}
`;

export default function NativeTemplateSectionEnhanced(props){
  const wrapperRef=useRef(null);
  const [effectsCount,setEffectsCount]=useState(0);

  useEffect(()=>{
    const wrapper=wrapperRef.current;
    if(!wrapper)return undefined;
    let releaseEffects=()=>{};
    let activeRoot=null;
    let frame=0;
    let tries=0;

    const connect=()=>{
      frame=0;
      const renderer=wrapper.querySelector('[data-template-renderer="native-shadow-dom"]');
      const host=renderer?.firstElementChild;
      const shadow=host?.shadowRoot;
      const root=shadow?.querySelector('.native-root');
      if(!host||!shadow||!root){
        if(tries<180){tries+=1;frame=requestAnimationFrame(connect);}
        return;
      }
      if(activeRoot===root)return;
      releaseEffects();
      activeRoot=root;
      const previous=shadow.querySelector('style[data-marktone-safe-motion]');
      previous?.remove();
      const style=document.createElement('style');
      style.setAttribute('data-marktone-safe-motion','v1');
      style.textContent=SAFE_MOTION_CSS;
      shadow.append(style);
      const controller=activateSafeTemplateEffects({
        host,root,shadow,
        template:{id:host.getAttribute('data-template-package')||props.templateId||props.entryUrl||'marktone-template'},
        editor:Boolean(props.editor)
      });
      setEffectsCount(controller.effectCount);
      releaseEffects=()=>{
        controller.release();
        style.remove();
      };
    };

    const observer=new MutationObserver(connect);
    observer.observe(wrapper,{subtree:true,childList:true,attributes:true,attributeFilter:['data-template-status']});
    connect();
    return()=>{
      observer.disconnect();
      if(frame)cancelAnimationFrame(frame);
      releaseEffects();
    };
  },[props.checksum,props.editor,props.entryUrl,props.nativeUrl,props.sectionIndex,props.sectionKey,props.templateId]);

  return <div ref={wrapperRef} style={{position:'relative'}} data-marktone-safe-effects-wrapper="true">
    <NativeTemplateSection {...props}/>
    {props.editor&&Number(props.scriptCount)>0&&<span style={{
      position:'absolute',left:10,bottom:10,zIndex:7,pointerEvents:'none',
      borderRadius:999,padding:'5px 8px',fontSize:8,fontWeight:900,
      background:'rgba(12,35,58,.9)',color:'#fff',boxShadow:'0 5px 18px rgba(0,0,0,.16)'
    }}>Safe Effects · {effectsCount} مؤثر آمن · JavaScript الخام غير منفذ</span>}
  </div>;
}
