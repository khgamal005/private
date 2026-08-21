export const NAVIGATION_RECOVERY_KEY='marktone.navigation-recovery-at';
export const NAVIGATION_RECOVERY_WINDOW_MS=30_000;

const RECOVERABLE_NAVIGATION_PATTERNS=[
  /minified react error #412/i,
  /connection closed/i,
  /failed to fetch.*(?:rsc|server component)/i,
  /chunkloaderror/i,
  /loading (?:css )?chunk .* failed/i,
  /failed to load (?:a )?chunk/i,
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i
];

function errorText(error){
  const values=[
    error?.name,
    error?.message,
    error?.cause?.name,
    error?.cause?.message
  ];
  return values.filter(value=>typeof value==='string').join(' ');
}

export function isRecoverableNavigationError(error){
  const text=errorText(error);
  return RECOVERABLE_NAVIGATION_PATTERNS.some(pattern=>pattern.test(text));
}

export function shouldAutoReloadNavigation({
  error,
  previousRecoveryAt=0,
  now=Date.now(),
  windowMs=NAVIGATION_RECOVERY_WINDOW_MS
}={}){
  if(!isRecoverableNavigationError(error))return false;
  const previous=Number(previousRecoveryAt);
  return !Number.isFinite(previous)||previous<=0||now-previous>=windowMs;
}
