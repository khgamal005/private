const crypto=require('node:crypto');
module.exports=function(source){
 const classes={};let css=String(source);
 if(this.resourcePath.endsWith('.module.css')){
  const prefix='qa'+crypto.createHash('sha256').update(this.resourcePath).digest('hex').slice(0,7)+'_';
  css=css.replace(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g,(match,key)=>{classes[key]=prefix+key;return '.'+classes[key];});
 }
 return `const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);export default ${JSON.stringify(classes)};`;
};
