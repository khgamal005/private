import React from 'react';
import {access} from './academy-fixtures.mjs';
export default function Link({href,children,prefetch:ignored,...props}){return <a {...props} href={href}>{children}</a>;}
export const usePathname=()=>window.location.pathname;
export const useSearchParams=()=>new URLSearchParams(window.location.search);
export const useRouter=()=>({refresh(){},push(path){window.location.assign(path);},replace(path){window.location.replace(path);}});
export const getAcademyAccess=async()=>access;
