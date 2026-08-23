"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type OdeirRegistrationModalProps = {
  open: boolean;
  onClose: () => void;
};

export default function OdeirRegistrationModal({ open, onClose }: OdeirRegistrationModalProps) {
  const [mounted, setMounted] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    setFrameReady(false);
    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
    };
  }, [open, onClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <div className="registration-modal-layer" data-registration-modal>
      <button
        className="registration-modal-backdrop"
        type="button"
        aria-label="إغلاق نافذة التسجيل"
        onClick={onClose}
      />
      <section
        className="registration-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="registration-modal-title"
        aria-describedby="registration-modal-description"
      >
        <header className="registration-modal-header">
          <div className="registration-modal-brand" aria-hidden="true">
            <Image
              src="/odeir/odeir-logo-transparent.webp"
              width={1126}
              height={522}
              alt=""
              priority
            />
          </div>
          <div className="registration-modal-heading">
            <span>ابدأ مع أودير</span>
            <h2 id="registration-modal-title">سجّل منشأتك مجانًا</h2>
            <p id="registration-modal-description">اعثر على منشأتك، تأكد من بياناتها، ثم أرسل طلب التفعيل بخطوات واضحة.</p>
          </div>
          <button
            ref={closeButtonRef}
            className="registration-modal-close"
            type="button"
            aria-label="إغلاق نافذة التسجيل"
            onClick={onClose}
          >
            <span aria-hidden="true" />
          </button>
        </header>

        <div className="registration-modal-content" aria-busy={!frameReady}>
          {!frameReady && <div className="registration-modal-loading" role="status">
            <i aria-hidden="true" />
            <span>نجهّز نموذج التسجيل…</span>
          </div>}
          <iframe
            className={frameReady ? "registration-modal-frame is-ready" : "registration-modal-frame"}
            src="/free-trial/apply?embedded=1"
            title="نموذج تسجيل منشأة في أودير"
            onLoad={() => setFrameReady(true)}
            referrerPolicy="same-origin"
          />
        </div>

        <footer className="registration-modal-footer">
          <span><i aria-hidden="true" /> بيانات الاتصال تظهر مقنّعة حتى التحقق من ملكية المنشأة.</span>
          <b>بدون بطاقة بنكية</b>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
