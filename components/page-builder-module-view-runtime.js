'use client';

import baseStyles from './page-document-renderer.module.css';
import proStyles from './page-document-renderer-pro.module.css';
import ImportedTemplateRuntime from './imported-template-runtime';
import {
  ModuleView as BaseModuleView,blockLabel,blockStyle,hiddenFor,safeCss
} from './page-builder-module-view.js';

const styles={...baseStyles,...proStyles};

export function ModuleView(props){
  const {block,editor=false,target,onInlineEdit,onActivate,nested=false}=props;
  const p=block?.props||{};
  if(block?.type!=='widget'||p.widgetKey!=='imported-template')return <BaseModuleView {...props}/>;
  const s=block.style||{};
  const className=[
    styles.block,nested?styles.nestedBlock:'',styles[`variant_${s.variant||'light'}`]||'',
    styles[`align_${s.align||'right'}`]||'',styles[`width_${s.maxWidth||'wide'}`]||'',safeClass(s.cssClass)
  ].filter(Boolean).join(' ');
  return <section
    id={p.anchor||undefined}
    className={`${className} ${styles.templateEmbed}`}
    style={blockStyle(s)}
    data-builder-type="widget"
    data-animation={s.animation&&s.animation!=='none'?s.animation:undefined}
  >
    <ImportedTemplateRuntime
      entryUrl={p.entryUrl}
      checksum={p.checksum}
      title={p.title}
      height={p.height}
      displayMode={p.displayMode||'auto'}
      textOverrides={p.textOverrides}
      editor={editor}
      target={target}
      onInlineEdit={onInlineEdit}
      onActivate={onActivate}
    />
  </section>;
}

export {blockLabel,blockStyle,hiddenFor,safeCss};

function safeClass(value){return String(value||'').replace(/[^a-zA-Z0-9_\- ]/g,'').slice(0,160)}
