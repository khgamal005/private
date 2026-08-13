'use client';

import baseStyles from './page-document-renderer.module.css';
import proStyles from './page-document-renderer-pro.module.css';
import ImportedTemplateRuntime from './imported-template-runtime';
import NativeTemplateSection from './native-template-section-enhanced';
import {
  ModuleView as BaseModuleView,blockLabel,blockStyle,hiddenFor,safeCss
} from './page-builder-module-view.js';

const styles={...baseStyles,...proStyles};
const NATIVE_TEMPLATE_KEY='native-template-section';
const LEGACY_TEMPLATE_KEY='imported-template';

export function ModuleView(props){
  const {block,editor=false,target,onInlineEdit,onActivate,nested=false}=props;
  const p=block?.props||{};
  const native=p.widgetKey===NATIVE_TEMPLATE_KEY;
  const legacy=p.widgetKey===LEGACY_TEMPLATE_KEY;
  if(block?.type!=='widget'||(!native&&!legacy))return <BaseModuleView {...props}/>;

  const s=block.style||{};
  const className=[
    styles.block,nested?styles.nestedBlock:'',styles[`variant_${s.variant||'light'}`]||'',
    styles[`align_${s.align||'right'}`]||'',styles[`width_${s.maxWidth||'full'}`]||'',safeClass(s.cssClass)
  ].filter(Boolean).join(' ');
  const common={
    entryUrl:p.entryUrl,
    nativeUrl:p.nativeUrl,
    checksum:p.checksum,
    title:p.title,
    templateId:p.templateId,
    scriptCount:Number(p.scriptCount)||0,
    textOverrides:p.textOverrides,
    editor,
    target,
    onInlineEdit,
    onActivate
  };

  return <section
    id={p.anchor||undefined}
    className={`${className} ${styles.templateEmbed}`}
    style={blockStyle(s)}
    data-builder-type="widget"
    data-template-renderer="native-shadow-dom"
    data-template-section={native?p.sectionKey||String(p.sectionIndex||0):'legacy-full-template'}
    data-animation={s.animation&&s.animation!=='none'?s.animation:undefined}
  >
    {native
      ?<NativeTemplateSection
        {...common}
        sectionKey={p.sectionKey}
        sectionIndex={p.sectionIndex}
      />
      :<ImportedTemplateRuntime {...common}/>
    }
  </section>;
}

export {blockLabel,blockStyle,hiddenFor,safeCss};

function safeClass(value){return String(value||'').replace(/[^a-zA-Z0-9_\- ]/g,'').slice(0,160)}
