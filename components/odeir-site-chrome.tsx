"use client";

import Image from "next/image";
import { type MouseEvent, useMemo, useState } from "react";
import { buildMenuTree } from "../lib/cms";

export type OdeirMenuItem = {
  id?: string;
  parentId?: string | null;
  label?: string;
  mobileLabel?: string;
  href?: string;
  description?: string;
  icon?: string;
  badge?: string;
  columnIndex?: number;
  sortOrder?: number;
  openInNewTab?: boolean;
  children?: OdeirMenuItem[];
};

export type OdeirChromeSettings = {
  customerLoginLabel?: string;
  customerLoginUrl?: string;
  contactCtaLabel?: string;
  contactCtaUrl?: string;
  freeTrialLabel?: string;
  freeTrialUrl?: string;
  footerText?: string;
};

type HeaderProps = {
  menu?: OdeirMenuItem[];
  settings?: OdeirChromeSettings;
  hero?: {
    primaryLabel?: string;
    primaryHref?: string;
  };
  onRegister?: () => void;
};

type FooterProps = {
  footerMenu?: OdeirMenuItem[];
  settings?: OdeirChromeSettings;
};

const DEFAULT_PRIMARY_MENU: OdeirMenuItem[] = [
  { id: "morning-brief", label: "أول فنجان", href: "/#morning-brief", sortOrder: 10, columnIndex: 1 },
  { id: "story", label: "التكاملات", href: "/#story", sortOrder: 20, columnIndex: 1 },
  { id: "product", label: "جولة داخل أودير", href: "/#product", sortOrder: 30, columnIndex: 1 },
  { id: "journey", label: "رحلة العميل", href: "/#journey", sortOrder: 40, columnIndex: 1 },
  { id: "marketplace", label: "متاجر أودير", href: "/#marketplace", sortOrder: 50, columnIndex: 1 },
  { id: "security", label: "الحماية", href: "/#security", sortOrder: 60, columnIndex: 1 },
];

const DEFAULT_FOOTER_MENU: OdeirMenuItem[] = [
  { id: "articles", label: "الأخبار والمعارف", href: "/articles", sortOrder: 10, columnIndex: 1 },
  { id: "home", label: "الرئيسية", href: "/", sortOrder: 20, columnIndex: 1 },
  { id: "free-trial", label: "التسجيل المجاني", href: "/free-trial", sortOrder: 30, columnIndex: 1 },
  { id: "privacy", label: "الخصوصية", href: "/p/privacy-policy", sortOrder: 40, columnIndex: 1 },
  { id: "information-security", label: "أمن المعلومات", href: "/p/information-security", sortOrder: 50, columnIndex: 1 },
  { id: "terms", label: "شروط الاستخدام", href: "/p/terms-of-use", sortOrder: 60, columnIndex: 1 },
  { id: "cookies", label: "ملفات الارتباط", href: "/p/cookie-policy", sortOrder: 70, columnIndex: 1 },
  { id: "data-rights", label: "حقوق البيانات", href: "/p/data-rights", sortOrder: 80, columnIndex: 1 },
];

export function ArrowMark() {
  return <span className="arrow-mark" aria-hidden="true" />;
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "brand brand--compact" : "brand"} aria-label="أودير ODEIR">
      <Image
        className="brand-logo"
        src="/odeir/odeir-logo-transparent.webp"
        width={1126}
        height={522}
        alt="أودير ODEIR — أدر على بيّنة"
      />
    </span>
  );
}

function opensRegistrationModal(href: string) {
  const path = String(href || "").trim().split(/[?#]/, 1)[0].replace(/^https?:\/\/[^/]+/i, "");
  return path === "/free-trial" || path === "/free-trial/apply";
}

export function openRegistrationFromLink(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onRegister?: () => void,
) {
  if (!onRegister || !opensRegistrationModal(href)) return;
  event.preventDefault();
  onRegister();
}

export function OdeirSiteHeader({
  menu,
  settings = {},
  hero = {},
  onRegister,
}: HeaderProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState("");
  const source = Array.isArray(menu) && menu.length ? menu : DEFAULT_PRIMARY_MENU;
  const tree = useMemo(() => {
    const items = buildMenuTree(source) as OdeirMenuItem[];
    return items.some(item => item.href === "/pricing") ? items : [...items, {id:"odeir-pricing",label:"الأسعار",href:"/pricing"}];
  }, [source]);
  const primaryLabel = hero.primaryLabel || settings.contactCtaLabel || settings.freeTrialLabel || "سجّل منشأتك مجانًا";
  const primaryHref = hero.primaryHref || settings.contactCtaUrl || settings.freeTrialUrl || "/free-trial/apply";
  const loginLabel = settings.customerLoginLabel || "دخول المنشآت";
  const loginHref = safeHref(settings.customerLoginUrl || "/login");
  const close = () => { setOpen(false); setExpanded(""); };

  return (
    <header className="site-header" data-managed-chrome="header">
      <a className="brand-link" href="/" aria-label="أودير - الرئيسية"><Brand /></a>
      <nav className={open ? "main-nav is-open" : "main-nav"} aria-label="التنقل الرئيسي">
        {tree.map((item) => (
          <OdeirNavItem
            key={item.id || `${item.label}-${item.href}`}
            item={item}
            expanded={expanded}
            setExpanded={setExpanded}
            close={close}
          />
        ))}
        <a className="mobile-nav-only" href={loginHref} onClick={close}>{loginLabel}</a>
        <a
          className="mobile-nav-only mobile-nav-cta"
          href={safeHref(primaryHref)}
          onClick={(event) => { close(); openRegistrationFromLink(event, primaryHref, onRegister); }}
        >{primaryLabel}</a>
      </nav>
      <div className="header-actions">
        <a className="login-link" href={loginHref}>{loginLabel}</a>
        <a
          className="button button--small"
          href={safeHref(primaryHref)}
          onClick={(event) => openRegistrationFromLink(event, primaryHref, onRegister)}
        >{primaryLabel.replace("منشأتك ", "")} <ArrowMark /></a>
      </div>
      <button
        className={open ? "menu-toggle is-open" : "menu-toggle"}
        type="button"
        aria-label={open ? "إغلاق القائمة" : "فتح القائمة"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      ><span /><span /><span /></button>
    </header>
  );
}

function OdeirNavItem({
  item,
  expanded,
  setExpanded,
  close,
}: {
  item: OdeirMenuItem;
  expanded: string;
  setExpanded: (value: string) => void;
  close: () => void;
}) {
  const children = Array.isArray(item.children) ? item.children : [];
  const href = safeHref(item.href || "#");
  const label = item.mobileLabel || item.label || "رابط";
  const target = item.openInNewTab ? "_blank" : undefined;
  const rel = item.openInNewTab ? "noreferrer" : undefined;
  if (!children.length) return <a href={href} target={target} rel={rel} onClick={close}>{label}</a>;
  const id = item.id || `${item.label}-${item.href}`;
  const isOpen = expanded === id;
  return (
    <div className={isOpen ? "odeir-nav-group is-open" : "odeir-nav-group"}>
      <span className="odeir-nav-parent">
        <a href={href} target={target} rel={rel} onClick={(event) => { if (href === "#") event.preventDefault(); else close(); }}>{label}</a>
        <button type="button" aria-label={`فتح قائمة ${label}`} aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? "" : id)}>⌄</button>
      </span>
      <div className="odeir-nav-dropdown">
        {children.map((child) => (
          <a key={child.id || `${child.label}-${child.href}`} href={safeHref(child.href || "#")} target={child.openInNewTab ? "_blank" : undefined} rel={child.openInNewTab ? "noreferrer" : undefined} onClick={close}>
            <b>{child.icon && <i>{child.icon}</i>}{child.mobileLabel || child.label}</b>
            {child.description && <small>{child.description}</small>}
          </a>
        ))}
      </div>
    </div>
  );
}

export function OdeirSiteFooter({ footerMenu, settings = {} }: FooterProps) {
  const source = Array.isArray(footerMenu) && footerMenu.length ? footerMenu : DEFAULT_FOOTER_MENU;
  const tree = useMemo(() => buildMenuTree(source) as OdeirMenuItem[], [source]);
  const links = useMemo(() => flattenMenu(tree).slice(0, 12), [tree]);
  return (
    <footer className="site-footer" data-managed-chrome="footer">
      <div className="footer-brand"><Brand /><p>{settings.footerText || "تشغيل أوضح وإدارة مترابطة للمنشآت التدريبية."}</p></div>
      <nav aria-label="روابط السياسات والمحتوى">
        {links.map((item) => <a key={item.id || `${item.label}-${item.href}`} href={safeHref(item.href || "#")} target={item.openInNewTab ? "_blank" : undefined} rel={item.openInNewTab ? "noreferrer" : undefined}>{item.mobileLabel || item.label}</a>)}
      </nav>
      <span>© {new Date().getFullYear()} أودير. جميع الحقوق محفوظة.</span>
    </footer>
  );
}

function flattenMenu(items: OdeirMenuItem[], result: OdeirMenuItem[] = []) {
  for (const item of items) {
    if (item.href && item.href !== "#") result.push(item);
    if (item.children?.length) flattenMenu(item.children, result);
  }
  return result;
}

function safeHref(value: string) {
  const href = String(value || "").trim();
  return /^(?:javascript|data|vbscript):/i.test(href) ? "#" : href || "#";
}
