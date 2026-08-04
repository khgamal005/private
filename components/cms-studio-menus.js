'use client';

import {flattenMenuTree} from '../lib/cms';
import {Empty,PanelHeading,MegaMenuPreview,newMenu,newMenuItem} from './cms-studio-ui';
import styles from './cms-studio.module.css';

export function MenusPanel({menus,activeMenu,activeTree,setActiveMenuId,setEditor,call,archive}){
  const flat=flattenMenuTree(activeTree);
  return <div className={styles.menuWorkspace}>
    <section className={styles.panel}>
      <PanelHeading title="القوائم الرئيسية" description="أنشئ أكثر من قائمة واربط عناصرها بصفحة أو مقال أو رابط، مع قوائم فرعية وميجا منيو حتى ثلاثة مستويات." action="قائمة جديدة" onAction={()=>setEditor({type:'menu',value:newMenu()})}/>
      <div className={styles.menuTabs}>{menus.map(menu=><button type="button" key={menu.id} className={menu.id===activeMenu?.id?styles.activeMenu:''} onClick={()=>setActiveMenuId(menu.id)}><span>{menu.location==='header'?'هيدر':menu.location==='footer'?'فوتر':menu.location==='mobile'?'جوال':'مخصصة'}</span><b>{menu.name}</b><small>{menu.itemCount||0} عنصر</small></button>)}</div>
      {activeMenu&&<div className={styles.menuHeader}><div><h3>{activeMenu.name}</h3><p>{activeMenu.description||'رتّب العناصر وأنشئ القوائم الفرعية والميجا منيو.'}</p></div><div><button type="button" onClick={()=>setEditor({type:'menu',value:activeMenu})}>إعدادات القائمة</button><button type="button" className={styles.primaryMini} onClick={()=>setEditor({type:'menuItem',value:newMenuItem(activeMenu.id)})}>إضافة عنصر +</button></div></div>}
      <div className={styles.menuTree}>{flat.map(item=><div key={item.id} className={styles.menuTreeItem} style={{'--depth':item.depth}}>
        <span className={styles.treeHandle}>⋮⋮</span><span className={styles.treeIcon}>{item.kind==='page'?'P':item.kind==='article'?'✎':item.kind==='group'?'▦':item.kind==='anchor'?'#':'↗'}</span>
        <div><b>{item.label}</b><small>{item.description||item.href}{item.badge&&<em>{item.badge}</em>}</small></div>
        <div className={styles.treeMeta}>{item.isMega&&<strong>MEGA</strong>}{item.parentId&&<span>فرعية</span>}<span>عمود {item.columnIndex}</span></div>
        <div className={styles.treeActions}>
          <button type="button" title="أعلى" onClick={()=>call('move-menu-item',{id:item.id,parentId:item.parentId,columnIndex:item.columnIndex,sortOrder:item.sortOrder-10},{message:'تم تغيير الترتيب'})}>↑</button>
          <button type="button" title="أسفل" onClick={()=>call('move-menu-item',{id:item.id,parentId:item.parentId,columnIndex:item.columnIndex,sortOrder:item.sortOrder+10},{message:'تم تغيير الترتيب'})}>↓</button>
          <button type="button" onClick={()=>setEditor({type:'menuItem',value:{...item,menuId:activeMenu.id}})}>تعديل</button>
          <button type="button" onClick={()=>setEditor({type:'menuItem',value:newMenuItem(activeMenu.id,item.id)})}>فرعي +</button>
          <button type="button" className={styles.dangerText} onClick={()=>archive('archive-menu-item',item.id,'عنصر القائمة')}>أرشفة</button>
        </div>
      </div>)}{!flat.length&&<Empty text="القائمة فارغة. أضف أول عنصر أو اربطه بصفحة موجودة."/>}</div>
    </section>
    <aside className={styles.menuPreviewPanel}>
      <div><span>معاينة حية</span><b>{activeMenu?.location==='header'?'شكل القائمة في الهيدر':'تركيب القائمة'}</b></div>
      <MegaMenuPreview tree={activeTree}/>
      <p>يمكن لكل عنصر رئيسي أن يتحول إلى Mega Menu بعدة أعمدة، ووصف وصورة وشارات.</p>
    </aside>
  </div>;
}
