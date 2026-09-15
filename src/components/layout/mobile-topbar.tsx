import { SidebarBrand } from './sidebar'

/** Barra superior do mobile e tablet. O menu completo mora na tab bar inferior. */
export function MobileTopbar() {
  return (
    <header className="h-14 flex items-center px-4 border-b border-line-subtle bg-surface-panel lg:hidden shrink-0">
      <SidebarBrand />
    </header>
  )
}
