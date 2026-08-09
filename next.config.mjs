const securityHeaders=[
  {key:'X-Content-Type-Options',value:'nosniff'},
  {key:'X-Frame-Options',value:'DENY'},
  {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
  {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'},
  {key:'Cross-Origin-Opener-Policy',value:'same-origin'},
  {key:'Strict-Transport-Security',value:'max-age=31536000; includeSubDomains'}
];

const noStoreHeaders=[
  {key:'Cache-Control',value:'private, no-store, no-cache, max-age=0, must-revalidate'},
  {key:'CDN-Cache-Control',value:'no-store'},
  {key:'Pragma',value:'no-cache'},
  {key:'Expires',value:'0'}
];

const nextConfig={
  poweredByHeader:false,
  reactStrictMode:true,
  async headers(){
    return [
      {source:'/control/website/builder/:path*',headers:[...securityHeaders,...noStoreHeaders]},
      {source:'/tenant/:slug/website/builder/:path*',headers:[...securityHeaders,...noStoreHeaders]},
      {source:'/api/cms/templates/:path*',headers:[...securityHeaders,...noStoreHeaders]},
      {source:'/api/cms/builder/:path*',headers:[...securityHeaders,...noStoreHeaders]},
      {source:'/:path*',headers:securityHeaders}
    ];
  }
};

export default nextConfig;
