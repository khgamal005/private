'use client';

const GROUPS=new Map();
const REVEAL_SELECTOR='[data-marktone-native-reveal="true"],.reveal,[data-reveal],.wow,[data-aos],.dashboard';
const COUNTER_SELECTOR='[data-counter]';
const TAB_SELECTOR='[role="tab"],[data-bs-toggle="tab"],[data-toggle="tab"],[data-bs-toggle="pill"]';

export function activateSafeTemplateEffects({host,root,shadow,template,editor=false}={}){
  if(!host||!root||!shadow||!template||typeof window==='undefined')return {effectCount:0,release(){}};
  const cleanups=[];
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches===true;
  const membership=registerTemplateRoot(template.id||host.getAttribute('data-template-package')||'template',{host,root,shadow});
  const effectCount=detectEffectCategories(root,membership.group);

  root.setAttribute('data-marktone-safe-effects','active');
  root.setAttribute('data-marktone-safe-effect-count',String(effectCount));
  cleanups.push(membership.release);
  cleanups.push(installRevealEffects(root,reduced));
  cleanups.push(installCounters(root,reduced));
  cleanups.push(installCurrentYear(root));
  cleanups.push(installScrollUi(root,host));
  cleanups.push(installMobileNavigation(root,editor));
  cleanups.push(installTabs(root,editor));
  cleanups.push(installCarousel(root,reduced,editor));
  cleanups.push(installHeroDepth(root,reduced,editor));
  cleanups.push(installOrbitGears(root,membership.group,reduced));
  cleanups.push(installActiveNavigation(root,membership.group));
  cleanups.push(installJourneyPath(root,host,membership.group,reduced));

  return {
    effectCount,
    release(){
      root.removeAttribute('data-marktone-safe-effects');
      root.removeAttribute('data-marktone-safe-effect-count');
      for(const cleanup of cleanups.reverse()){
        try{cleanup?.()}catch{}
      }
    }
  };
}

function detectEffectCategories(root,group){
  let count=0;
  if(root.querySelector(REVEAL_SELECTOR))count+=1;
  if(root.querySelector(COUNTER_SELECTOR))count+=1;
  if(root.querySelector('.scroll-progress span,[data-scroll-progress]'))count+=1;
  if(root.querySelector('.site-header,[data-sticky-header]'))count+=1;
  if(root.querySelector('.menu-toggle')&&root.querySelector('.primary-nav'))count+=1;
  if(root.querySelector(TAB_SELECTOR))count+=1;
  if(root.querySelector('.carousel,[data-marktone-slider]'))count+=1;
  if(root.querySelector('.hero')&&root.querySelector('.hero-image-wrap'))count+=1;
  if(root.querySelector('.gears-grid .gear-card'))count+=1;
  if(root.querySelector('.primary-nav a[href^="#"]'))count+=1;
  if(root.querySelector('#journey-svg,#journey-active'))count+=1;
  if(root.querySelector('#year,[data-current-year]'))count+=1;
  if(!count&&group&&queryGroup(group,REVEAL_SELECTOR).length)count=1;
  return count;
}

function installRevealEffects(root,reduced){
  const elements=[...root.querySelectorAll(REVEAL_SELECTOR)];
  if(!elements.length)return noop;
  const show=element=>{
    element.classList.add('in-view','aos-animate','is-visible');
    element.setAttribute('data-marktone-safe-visible','true');
  };
  if(reduced||!('IntersectionObserver' in window)){
    elements.forEach(show);
    return noop;
  }
  const observer=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(!entry.isIntersecting)continue;
      show(entry.target);
      observer.unobserve(entry.target);
    }
  },{threshold:0.12,rootMargin:'0px 0px -6% 0px'});
  elements.forEach(element=>observer.observe(element));
  return()=>observer.disconnect();
}

function installCounters(root,reduced){
  const counters=[...root.querySelectorAll(COUNTER_SELECTOR)];
  if(!counters.length)return noop;
  const animations=new Set();
  const animate=element=>{
    if(element.dataset.marktoneCounted==='true')return;
    element.dataset.marktoneCounted='true';
    const target=finite(element.dataset.counter,0);
    const prefix=String(element.dataset.prefix||'');
    const suffix=String(element.dataset.suffix||(prefix==='+'||prefix==='-'?'%':''));
    const duration=reduced?1:Math.max(250,finite(element.dataset.duration,1350));
    const start=performance.now();
    const frame=now=>{
      const progress=Math.min(Math.max((now-start)/duration,0),1);
      const eased=1-Math.pow(1-progress,4);
      const value=Math.round(target*eased);
      element.textContent=`${prefix}${value.toLocaleString('en-US')}${suffix}`;
      if(progress<1){
        const id=requestAnimationFrame(frame);
        animations.add(id);
      }
    };
    const id=requestAnimationFrame(frame);
    animations.add(id);
  };
  if(reduced||!('IntersectionObserver' in window)){
    counters.forEach(animate);
    return()=>animations.forEach(id=>cancelAnimationFrame(id));
  }
  const observer=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(!entry.isIntersecting)continue;
      animate(entry.target);
      observer.unobserve(entry.target);
    }
  },{threshold:0.55});
  counters.forEach(counter=>observer.observe(counter));
  return()=>{
    observer.disconnect();
    animations.forEach(id=>cancelAnimationFrame(id));
  };
}

function installCurrentYear(root){
  const elements=[...root.querySelectorAll('#year,[data-current-year]')];
  if(!elements.length)return noop;
  const year=String(new Date().getFullYear());
  for(const element of elements)element.textContent=year;
  return noop;
}

function installScrollUi(root,host){
  const headers=[...root.querySelectorAll('.site-header,[data-sticky-header]')];
  const bars=[...root.querySelectorAll('.scroll-progress span,[data-scroll-progress]')];
  if(!headers.length&&!bars.length)return noop;
  const source=findScrollSource(host);
  const update=rafThrottle(()=>{
    const metrics=scrollMetrics(source);
    headers.forEach(header=>header.classList.toggle('scrolled',metrics.top>20));
    const progress=metrics.max>0?clamp(metrics.top/metrics.max,0,1):0;
    bars.forEach(bar=>{
      bar.style.transform=`scaleX(${progress})`;
      bar.style.transformOrigin=bar.dir==='rtl'?'right center':'left center';
      bar.setAttribute('data-progress',progress.toFixed(4));
    });
  });
  source.addEventListener('scroll',update,{passive:true});
  window.addEventListener('resize',update,{passive:true});
  update();
  return()=>{
    source.removeEventListener('scroll',update);
    window.removeEventListener('resize',update);
  };
}

function installMobileNavigation(root,editor){
  const button=root.querySelector('.menu-toggle');
  const nav=root.querySelector('.primary-nav');
  if(!button||!nav||editor)return noop;
  const links=[...nav.querySelectorAll('a')];
  const close=()=>{
    button.setAttribute('aria-expanded','false');
    nav.classList.remove('open','show');
    root.classList.remove('menu-open');
  };
  const toggle=event=>{
    event.preventDefault();
    const open=button.getAttribute('aria-expanded')==='true';
    button.setAttribute('aria-expanded',String(!open));
    nav.classList.toggle('open',!open);
    nav.classList.toggle('show',!open);
    root.classList.toggle('menu-open',!open);
  };
  const escape=event=>{if(event.key==='Escape')close();};
  button.addEventListener('click',toggle);
  links.forEach(link=>link.addEventListener('click',close));
  window.addEventListener('keydown',escape);
  return()=>{
    button.removeEventListener('click',toggle);
    links.forEach(link=>link.removeEventListener('click',close));
    window.removeEventListener('keydown',escape);
  };
}

function installTabs(root,editor){
  const controls=[...root.querySelectorAll(TAB_SELECTOR)];
  if(!controls.length||editor)return noop;
  const listeners=[];
  for(const control of controls){
    const click=event=>{
      const selector=control.getAttribute('data-bs-target')||control.getAttribute('data-target')||control.getAttribute('href')||'';
      if(!selector.startsWith('#'))return;
      const target=findLocalId(root,selector.slice(1));
      if(!target)return;
      event.preventDefault();
      const scope=control.closest('[role="tablist"],.nav,.tabs,[data-tabs]')||control.parentElement;
      const peers=scope?[...scope.querySelectorAll(TAB_SELECTOR)]:controls;
      for(const peer of peers){
        peer.classList.toggle('active',peer===control);
        peer.setAttribute('aria-selected',peer===control?'true':'false');
        const peerSelector=peer.getAttribute('data-bs-target')||peer.getAttribute('data-target')||peer.getAttribute('href')||'';
        if(peerSelector.startsWith('#')){
          const panel=findLocalId(root,peerSelector.slice(1));
          if(panel){
            panel.classList.toggle('active',peer===control);
            panel.classList.toggle('show',peer===control);
            panel.toggleAttribute('hidden',peer!==control);
          }
        }
      }
    };
    control.addEventListener('click',click);
    listeners.push(()=>control.removeEventListener('click',click));
  }
  return()=>listeners.forEach(release=>release());
}

function installCarousel(root,reduced,editor){
  const carousels=[...root.querySelectorAll('.carousel,[data-marktone-slider]')];
  if(!carousels.length||editor)return noop;
  const cleanups=[];
  for(const carousel of carousels){
    const slides=[...carousel.querySelectorAll('.carousel-item,[data-slide]')];
    if(slides.length<2)continue;
    let active=Math.max(0,slides.findIndex(slide=>slide.classList.contains('active')));
    if(active<0)active=0;
    const show=index=>{
      active=(index+slides.length)%slides.length;
      slides.forEach((slide,slideIndex)=>{
        const visible=slideIndex===active;
        slide.classList.toggle('active',visible);
        slide.toggleAttribute('hidden',!visible);
        slide.setAttribute('aria-hidden',visible?'false':'true');
      });
    };
    show(active);
    const previous=event=>{event.preventDefault();show(active-1);};
    const next=event=>{event.preventDefault();show(active+1);};
    const prevButtons=[...carousel.querySelectorAll('[data-bs-slide="prev"],[data-slide="prev"],.carousel-control-prev')];
    const nextButtons=[...carousel.querySelectorAll('[data-bs-slide="next"],[data-slide="next"],.carousel-control-next')];
    prevButtons.forEach(button=>button.addEventListener('click',previous));
    nextButtons.forEach(button=>button.addEventListener('click',next));
    let timer=0;
    if(!reduced&&carousel.getAttribute('data-bs-ride')==='carousel')timer=window.setInterval(()=>show(active+1),Math.max(1800,finite(carousel.getAttribute('data-bs-interval'),5000)));
    cleanups.push(()=>{
      prevButtons.forEach(button=>button.removeEventListener('click',previous));
      nextButtons.forEach(button=>button.removeEventListener('click',next));
      if(timer)window.clearInterval(timer);
    });
  }
  return()=>cleanups.forEach(release=>release());
}

function installHeroDepth(root,reduced,editor){
  const hero=root.querySelector('.hero');
  const image=root.querySelector('.hero-image-wrap');
  if(!hero||!image||reduced||editor||!window.matchMedia?.('(pointer: fine)')?.matches)return noop;
  const move=rafThrottle(event=>{
    const rect=hero.getBoundingClientRect();
    if(!rect.width||!rect.height)return;
    const x=(event.clientX-rect.left)/rect.width-.5;
    const y=(event.clientY-rect.top)/rect.height-.5;
    image.style.transform=`perspective(1200px) rotateY(${x*-2.8}deg) rotateX(${y*2.2}deg)`;
  });
  const leave=()=>{image.style.transform='';};
  hero.addEventListener('pointermove',move);
  hero.addEventListener('pointerleave',leave);
  return()=>{
    hero.removeEventListener('pointermove',move);
    hero.removeEventListener('pointerleave',leave);
    image.style.transform='';
  };
}

function installOrbitGears(root,group,reduced){
  const stage=root.querySelector('.gears-grid');
  const gears=stage?[...stage.querySelectorAll('.gear-card')]:[];
  if(!stage||gears.length<2)return noop;
  const core=stage.querySelector('.gears-core');
  const sharedLogo=queryGroup(group,'.orbit-core img')[0];
  if(core&&sharedLogo&&!core.querySelector('img')){
    const clone=sharedLogo.cloneNode(true);
    clone.alt=clone.alt||'Marktone';
    clone.removeAttribute('aria-hidden');
    core.append(clone);
  }
  let frame=0;
  const position=time=>{
    const width=stage.clientWidth;
    const height=stage.clientHeight;
    if(width&&height){
      const centerX=width/2;
      const centerY=height/2;
      const radius=Math.min(width,height)*.37;
      const rotation=reduced?0:(time/26000)*Math.PI*2;
      gears.forEach((gear,index)=>{
        const angle=-Math.PI/2+(index*Math.PI*2/gears.length)+rotation;
        gear.style.position='absolute';
        gear.style.left=`${centerX+Math.cos(angle)*radius-gear.offsetWidth/2}px`;
        gear.style.top=`${centerY+Math.sin(angle)*radius-gear.offsetHeight/2}px`;
      });
    }
    if(!reduced)frame=requestAnimationFrame(position);
  };
  frame=requestAnimationFrame(position);
  return()=>{if(frame)cancelAnimationFrame(frame);};
}

function installActiveNavigation(root,group){
  const links=[...root.querySelectorAll('.primary-nav a[href^="#"]')];
  if(!links.length||!('IntersectionObserver' in window))return noop;
  let observer=null;
  const rebuild=()=>{
    observer?.disconnect();
    const pairs=links.map(link=>{
      const id=decodeURIComponent(String(link.getAttribute('href')||'').slice(1));
      const byData=queryGroup(group,`[data-nav="${cssEscape(id)}"]`)[0];
      return {link,target:byData||findGroupId(group,id),id};
    }).filter(pair=>pair.target);
    if(!pairs.length)return;
    const byTarget=new Map(pairs.map(pair=>[pair.target,pair]));
    observer=new IntersectionObserver(entries=>{
      const visible=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];
      if(!visible)return;
      const active=byTarget.get(visible.target);
      if(!active)return;
      links.forEach(link=>link.classList.toggle('active',link===active.link));
    },{threshold:[.16,.3,.5],rootMargin:'-24% 0px -60% 0px'});
    pairs.forEach(pair=>observer.observe(pair.target));
  };
  const unsubscribe=subscribeGroup(group,rebuild);
  rebuild();
  return()=>{unsubscribe();observer?.disconnect();};
}

function installJourneyPath(root,host,group,reduced){
  const svg=root.querySelector('#journey-svg');
  const track=root.querySelector('#journey-track');
  const shadow=root.querySelector('#journey-shadow');
  const active=root.querySelector('#journey-active');
  const head=root.querySelector('#journey-glow-head');
  if(!svg||!track||!active)return noop;
  const source=findScrollSource(host);
  let length=0;
  let frame=0;
  let resizeObserver=null;

  const update=()=>{
    if(!length)return;
    const bounds=templateBounds(group);
    const viewportHeight=window.innerHeight||720;
    const progress=clamp((viewportHeight*.72-bounds.top)/Math.max(bounds.height,1),0,1);
    active.style.strokeDashoffset=`${length*(1-progress)}`;
    if(head){
      try{
        const point=active.getPointAtLength(length*progress);
        head.setAttribute('transform',`translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`);
        head.style.opacity=progress>.002&&progress<.998?'1':'0';
      }catch{}
    }
  };
  const schedule=()=>{
    if(frame)return;
    frame=requestAnimationFrame(()=>{frame=0;build();update();});
  };
  const build=()=>{
    const points=queryGroup(group,'.trail-point');
    if(points.length<2)return;
    const svgRect=svg.getBoundingClientRect();
    const bounds=templateBounds(group);
    const width=Math.max(svgRect.width,bounds.width,1);
    const height=Math.max(bounds.bottom-svgRect.top,svgRect.height,1);
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio','none');
    svg.style.width=`${width}px`;
    svg.style.height=`${height}px`;
    svg.style.maxWidth='none';
    svg.style.overflow='visible';

    const coordinates=points.map(point=>{
      const selector=point.dataset.trailTarget;
      const target=selector?queryGroup(group,selector)[0]:point;
      const rect=(target||point).getBoundingClientRect();
      const y=point.dataset.trailAnchor==='bottom'?rect.bottom:rect.top+rect.height/2;
      const explicitX=finite(point.dataset.trailX,NaN);
      return {
        x:Number.isFinite(explicitX)?width*(explicitX/100):rect.left+rect.width/2-svgRect.left,
        y:y-svgRect.top
      };
    });
    let path=`M ${coordinates[0].x.toFixed(2)} ${coordinates[0].y.toFixed(2)}`;
    for(let index=1;index<coordinates.length;index+=1){
      const previous=coordinates[index-1];
      const current=coordinates[index];
      const distance=current.y-previous.y;
      const bend=Math.max(Math.min(Math.abs(distance)*.42,250),75)*(distance<0?-1:1);
      path+=` C ${previous.x.toFixed(2)} ${(previous.y+bend).toFixed(2)}, ${current.x.toFixed(2)} ${(current.y-bend).toFixed(2)}, ${current.x.toFixed(2)} ${current.y.toFixed(2)}`;
    }
    [track,shadow,active].filter(Boolean).forEach(element=>element.setAttribute('d',path));
    try{length=active.getTotalLength();}catch{length=0;}
    if(length){
      active.style.strokeDasharray=String(length);
      active.style.strokeDashoffset=String(length);
      if(reduced)active.style.strokeDashoffset='0';
    }
  };

  const unsubscribe=subscribeGroup(group,schedule);
  const onScroll=rafThrottle(update);
  source.addEventListener('scroll',onScroll,{passive:true});
  window.addEventListener('resize',schedule,{passive:true});
  resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(schedule):null;
  resizeObserver?.observe(host);
  schedule();
  const timers=[window.setTimeout(schedule,120),window.setTimeout(schedule,900)];
  return()=>{
    unsubscribe();
    source.removeEventListener('scroll',onScroll);
    window.removeEventListener('resize',schedule);
    resizeObserver?.disconnect();
    timers.forEach(timer=>window.clearTimeout(timer));
    if(frame)cancelAnimationFrame(frame);
  };
}

function registerTemplateRoot(id,member){
  const key=String(id||'template');
  let group=GROUPS.get(key);
  if(!group){
    group={id:key,members:new Set(),listeners:new Set()};
    GROUPS.set(key,group);
  }
  group.members.add(member);
  notifyGroup(group);
  return {
    group,
    release(){
      group.members.delete(member);
      notifyGroup(group);
      if(!group.members.size){
        group.listeners.clear();
        GROUPS.delete(key);
      }
    }
  };
}

function subscribeGroup(group,listener){
  if(!group)return noop;
  group.listeners.add(listener);
  return()=>group.listeners.delete(listener);
}

function notifyGroup(group){
  queueMicrotask(()=>{
    for(const listener of [...group.listeners]){
      try{listener()}catch{}
    }
  });
}

function queryGroup(group,selector){
  const output=[];
  if(!group||!selector)return output;
  for(const member of group.members){
    try{output.push(...member.root.querySelectorAll(selector));}catch{}
  }
  return output;
}

function findGroupId(group,id){
  if(!group||!id)return null;
  for(const member of group.members){
    const match=findLocalId(member.root,id);
    if(match)return match;
  }
  return null;
}

function findLocalId(root,id){
  const value=String(id||'');
  for(const element of root.querySelectorAll('[id]'))if(element.id===value)return element;
  return null;
}

function templateBounds(group){
  const rects=[...(group?.members||[])].map(member=>member.host.getBoundingClientRect()).filter(rect=>rect.width||rect.height);
  if(!rects.length)return {top:0,bottom:1,left:0,right:1,width:1,height:1};
  const top=Math.min(...rects.map(rect=>rect.top));
  const bottom=Math.max(...rects.map(rect=>rect.bottom));
  const left=Math.min(...rects.map(rect=>rect.left));
  const right=Math.max(...rects.map(rect=>rect.right));
  return {top,bottom,left,right,width:Math.max(1,right-left),height:Math.max(1,bottom-top)};
}

function findScrollSource(host){
  const stage=host.closest?.('[data-builder-scroll-container="true"]');
  return stage||window;
}

function scrollMetrics(source){
  if(source===window){
    const root=document.documentElement;
    const body=document.body;
    const top=window.scrollY||root.scrollTop||body?.scrollTop||0;
    const height=Math.max(root.scrollHeight,body?.scrollHeight||0);
    return {top,max:Math.max(0,height-window.innerHeight)};
  }
  return {top:source.scrollTop,max:Math.max(0,source.scrollHeight-source.clientHeight)};
}

function rafThrottle(callback){
  let queued=false;
  let latestArgs=[];
  const wrapped=(...args)=>{
    latestArgs=args;
    if(queued)return;
    queued=true;
    requestAnimationFrame(()=>{
      queued=false;
      callback(...latestArgs);
    });
  };
  return wrapped;
}

function cssEscape(value){
  if(typeof CSS!=='undefined'&&CSS.escape)return CSS.escape(String(value||''));
  return String(value||'').replace(/[^a-zA-Z0-9_-]/g,'\\$&');
}
function finite(value,fallback){const number=Number(value);return Number.isFinite(number)?number:fallback;}
function clamp(value,min,max){return Math.min(Math.max(Number(value)||0,min),max);}
function noop(){}
