'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavLinkProps = {
  href: string;
  label: string;
  icon: string;
};

/**
 * A workspace nav entry that knows whether it is the current section.
 *
 * `usePathname` is the only reason this is a client component: the layout is a
 * Server Component, and the active state has to survive client-side navigation.
 */
export function NavLink({ href, label, icon }: NavLinkProps) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={
        active
          ? 'flex shrink-0 items-center gap-3 rounded-xl bg-emerald-400/10 px-3 py-3 text-sm font-medium text-emerald-300'
          : 'flex shrink-0 items-center gap-3 rounded-xl px-3 py-3 text-sm text-slate-400 hover:bg-white/5 hover:text-slate-200'
      }
    >
      <span className="w-5 text-center">{icon}</span>
      {label}
    </Link>
  );
}
