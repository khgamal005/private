'use client';

import NativeTemplateSection from './native-template-section';

export default function ImportedTemplateRuntime({
  entryUrl='',nativeUrl='',checksum='',title='قالب ZIP مستورد',templateId='',
  textOverrides={},editor=false,target,onInlineEdit,onActivate
}){
  return <NativeTemplateSection
    entryUrl={entryUrl}
    nativeUrl={nativeUrl}
    checksum={checksum}
    title={title}
    templateId={templateId}
    textOverrides={textOverrides}
    editor={editor}
    target={target}
    onInlineEdit={onInlineEdit}
    onActivate={onActivate}
    renderAll
  />;
}
