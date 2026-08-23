const securityHeaders=[
  {key:'X-Content-Type-Options',value:'nosniff'},
  {key:'X-Frame-Options',value:'DENY'},
  {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
  {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'},
  {key:'Cross-Origin-Opener-Policy',value:'same-origin'},
  {key:'Strict-Transport-Security',value:'max-age=31536000; includeSubDomains'}
];

const streamingHeaders=[
  {key:'X-Accel-Buffering',value:'no'}
];

const noStoreHeaders=[
  {key:'Cache-Control',value:'private, no-store, no-cache, max-age=0, must-revalidate'},
  {key:'CDN-Cache-Control',value:'no-store'},
  {key:'Pragma',value:'no-cache'},
  {key:'Expires',value:'0'}
];

const publicAuthPageHeaders=[
  {
    key:'Cache-Control',
    value:'public, max-age=0, s-maxage=300, must-revalidate, stale-if-error=86400'
  },
  {
    key:'CDN-Cache-Control',
    value:'public, s-maxage=300, must-revalidate, stale-if-error=86400'
  },
  ...streamingHeaders
];

const protectedPageHeaders=[...noStoreHeaders,...streamingHeaders];

const nextConfig={
  poweredByHeader:false,
  reactStrictMode:true,
  async headers(){
    return [
      {source:'/login',headers:publicAuthPageHeaders},
      {source:'/forgot-password',headers:publicAuthPageHeaders},
      {source:'/reset-password',headers:publicAuthPageHeaders},
      {source:'/change-password',headers:protectedPageHeaders},
      {source:'/accept-invite',headers:protectedPageHeaders},
      {source:'/accept-platform-invite',headers:protectedPageHeaders},
      {source:'/control/website/builder/:path*',headers:protectedPageHeaders},
      {source:'/tenant/:slug/website/builder/:path*',headers:protectedPageHeaders},
      {source:'/control/:path*',headers:protectedPageHeaders},
      {source:'/tenant/:path*',headers:protectedPageHeaders},
      {source:'/api/auth/:path*',headers:noStoreHeaders},
      {source:'/api/cms/templates/:path*',headers:noStoreHeaders},
      {source:'/api/cms/builder/:path*',headers:noStoreHeaders},
      {source:'/:path*',headers:securityHeaders}
    ];
  }
};

export default nextConfig;
