import {trainingRpc} from './training-server';
export const getAcademyCommerceSnapshot=(slug,offset=0)=>trainingRpc('v1_academy_commerce_snapshot',{p_slug:slug,p_offset:offset});
export const getAcademyStorefront=slug=>trainingRpc('v1_academy_storefront',{p_slug:slug},{publicAccess:true});
