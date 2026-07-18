import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Extension entry point.
 *
 * The provider-neutral contracts and first useful tool will be added before
 * this package is installed into a working Pi configuration.
 */
export default function (pi: ExtensionAPI): void {
  void pi;
}
