/* eslint-disable @next/next/no-img-element -- isolated preview has no Next image server */
import React from 'react';
export default function Image({src,alt,width,height,className,style}){return <img src={typeof src==='string'?src:src?.src} alt={alt||''} width={width} height={height} className={className} style={style}/>;}
