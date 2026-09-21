// Lucide ships dynamic.mjs beside dynamic.d.ts without an exports map.
// Use the explicit runtime extension for Node SSR and retain its public types.
declare module "lucide-react/dynamic.mjs" {
  export { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic"
}
