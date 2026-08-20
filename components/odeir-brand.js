import Image from 'next/image';
import styles from './odeir-brand.module.css';

export default function OdeirBrand({
  subtitle='منصة إدارة المنشآت',
  compact=false,
  inverse=true,
  className=''
}){
  const label=['أودير ODEIR',subtitle].filter(Boolean).join(' — ');
  const artwork=inverse?'/odeir/odeir-logo-dark.png':'/odeir/odeir-logo-official.png';
  return <span
    className={`${styles.brand} ${inverse?'':styles.onLight} ${compact?styles.compact:''} ${className}`.trim()}
    dir="ltr"
    role="img"
    aria-label={label}
  >
    <span className={styles.logoFrame} aria-hidden="true">
      <Image
        className={styles.artwork}
        src={artwork}
        alt=""
        width={768}
        height={512}
      />
    </span>
  </span>;
}
