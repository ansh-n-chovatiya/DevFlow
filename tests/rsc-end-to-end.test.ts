/**
 * A Next.js App Router recording, from the payload the extension posts to the
 * reply a tool gives — and what a real run found that no fixture had.
 *
 * This is the RSC half of what `framework-end-to-end.test.ts` is for Vue: a real
 * application (`next dev` on 3000, `next build && next start` on 3001), the built
 * extension driven in a headed Chromium, and the ids below are the ones that run
 * minted. The app is a genuinely mixed tree — a server-only component, a
 * `use client` component with a click handler nested inside another client
 * component, and a Suspense boundary over an awaited server component.
 *
 * Next 16.3.4 / React 19.2.8, Turbopack, default `next.config.mjs`.
 *
 * Paths were rewritten from the throwaway app directory to `/APP` and are
 * otherwise verbatim. Nothing here is hand-authored except that substitution.
 *
 * Three of these tests pin behaviour that is **wrong**, and say so where they
 * stand. They are here rather than in a note because a defect nobody can see is
 * a defect nobody fixes, and each one will go red the moment its fix lands —
 * which is the signal to invert the assertion, not to delete it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type McpSession } from './helpers/mcp-server.js';
import { createRscAdapter } from '../src/core/rsc/adapter.js';

let home: string;
let server: McpSession;

/**
 * The `next dev` recording: three clicks, on a client button, on the div a
 * server-only component rendered, and on the div inside the Suspense boundary.
 */
const devFlow = {
    "schemaVersion": 1,
    "id": "rsc-real-dev",
    "name": "RSC Real App — next dev",
    "timestamp": 1788519600000,
    "startUrl": "http://localhost:3000/",
    "steps": [
      {
        "type": "click",
        "url": "http://localhost:3000/",
        "timestamp": 1788519601000,
        "action": "Clicked \"#checkout\"",
        "stepNumber": 1,
        "element": {
          "tag": "button",
          "label": "Checkout (0)",
          "cssSelector": "#checkout",
          "xpath": "//*[@id=\"checkout\"]",
          "boundingBox": null,
          "frameworks": [
            {
              "chain": [
                "1a9c4d2131",
                "db9f129121",
                "2c24ad1606",
                "5f06a63585",
                "f16b9cd929",
                "ne83d9196",
                "85d3f5e1f1",
                "5b61c9d4e4"
              ],
              "framework": "rsc"
            }
          ],
          "react": {
            "chain": [
              "98ff6986b6",
              "4af7b53525",
              "c0c6011d2d",
              "2e7175ac5c",
              "1a9c4d2131",
              "db9f129121",
              "2c24ad1606",
              "5f06a63585",
              "n4a762f6d",
              "f16b9cd929",
              "85d3f5e1f1",
              "5b61c9d4e4"
            ],
            "truncated": true,
            "owner": "5b61c9d4e4"
          }
        }
      },
      {
        "type": "click",
        "url": "http://localhost:3000/",
        "timestamp": 1788519602000,
        "action": "Clicked \"#server-panel\"",
        "stepNumber": 2,
        "element": {
          "tag": "div",
          "label": "ServerOnlyPanel",
          "cssSelector": "#server-panel",
          "xpath": "//*[@id=\"server-panel\"]",
          "boundingBox": null,
          "frameworks": [
            {
              "chain": [
                "4af7b53525",
                "c0c6011d2d",
                "2e7175ac5c",
                "1a9c4d2131",
                "db9f129121",
                "2c24ad1606",
                "5f06a63585",
                "f16b9cd929",
                "ne83d9196",
                "649e8554e4"
              ],
              "framework": "rsc"
            }
          ],
          "react": {
            "chain": [
              "3f5ade7c6c",
              "e753550010",
              "98ff6986b6",
              "4af7b53525",
              "c0c6011d2d",
              "2e7175ac5c",
              "1a9c4d2131",
              "db9f129121",
              "2c24ad1606",
              "5f06a63585",
              "n4a762f6d",
              "f16b9cd929"
            ],
            "truncated": true,
            "owner": "n4a762f6d"
          }
        }
      },
      {
        "type": "click",
        "url": "http://localhost:3000/",
        "timestamp": 1788519603000,
        "action": "Clicked \"#slow-server-data\"",
        "stepNumber": 3,
        "element": {
          "tag": "div",
          "label": "SlowServerData",
          "cssSelector": "#slow-server-data",
          "xpath": "//*[@id=\"slow-server-data\"]",
          "boundingBox": null,
          "frameworks": [
            {
              "chain": [
                "2e7175ac5c",
                "1a9c4d2131",
                "db9f129121",
                "2c24ad1606",
                "5f06a63585",
                "f16b9cd929",
                "ne83d9196",
                "928c8ff040"
              ],
              "framework": "rsc"
            }
          ],
          "react": {
            "chain": [
              "3f5ade7c6c",
              "e753550010",
              "98ff6986b6",
              "4af7b53525",
              "c0c6011d2d",
              "2e7175ac5c",
              "1a9c4d2131",
              "db9f129121",
              "2c24ad1606",
              "5f06a63585",
              "n4a762f6d",
              "f16b9cd929"
            ],
            "truncated": true,
            "owner": "n4a762f6d"
          }
        }
      }
    ],
    "rsc": {
      "detected": true,
      "version": "16.3.4",
      "build": "development",
      "components": {
        "1a9c4d2131": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "HTTPAccessFallbackErrorBoundary",
          "status": "pending"
        },
        "db9f129121": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "RedirectBoundary",
          "status": "pending"
        },
        "2c24ad1606": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "RedirectErrorBoundary",
          "status": "pending"
        },
        "5f06a63585": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "InnerLayoutRouter",
          "status": "pending"
        },
        "f16b9cd929": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "SegmentViewNode",
          "status": "pending"
        },
        "ne83d9196": {
          "detail": "Page ran on the server and this build named it without a source frame, so there is no file to open. Its props and owner chain are still readable.",
          "name": "Page",
          "status": "not-found"
        },
        "2e7175ac5c": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "HTTPAccessFallbackBoundary",
          "status": "pending"
        },
        "928c8ff040": {
          "column": 278,
          "line": 177,
          "name": "SlowServerData",
          "source": "/APP/.next/dev/server/chunks/ssr/[root-of-the-server]__1yg-s_y._.js",
          "status": "resolved",
          "via": "debug-source"
        }
      }
    },
    "react": {
      "detected": true,
      "build": "development",
      "components": {
        "98ff6986b6": {
          "absolutePath": "/APP/node_modules/next/src/client/components/layout-router.tsx",
          "column": 1,
          "compiled": {
            "column": 4,
            "line": 556,
            "url": "http://localhost:3000/_next/static/chunks/node_modules_next_dist_20wefz_._.js"
          },
          "dependency": true,
          "line": 330,
          "name": "InnerScrollHandlerNew",
          "source": "/APP/node_modules/next/src/client/components/layout-router.tsx",
          "status": "resolved",
          "via": "bundle-search"
        },
        "4af7b53525": {
          "absolutePath": "/APP/node_modules/next/src/client/components/error-boundary.tsx",
          "column": 8,
          "compiled": {
            "column": 0,
            "line": 2285,
            "url": "http://localhost:3000/_next/static/chunks/node_modules_next_dist_client_0_90u2t._.js"
          },
          "dependency": true,
          "line": 153,
          "name": "ErrorBoundary",
          "source": "/APP/node_modules/next/src/client/components/error-boundary.tsx",
          "status": "resolved",
          "via": "bundle-search"
        },
        "c0c6011d2d": {
          "absolutePath": "/APP/node_modules/next/src/client/components/layout-router.tsx",
          "column": 1,
          "compiled": {
            "column": 4,
            "line": 787,
            "url": "http://localhost:3000/_next/static/chunks/node_modules_next_dist_20wefz_._.js"
          },
          "dependency": true,
          "line": 665,
          "name": "LoadingBoundary",
          "source": "/APP/node_modules/next/src/client/components/layout-router.tsx",
          "status": "resolved",
          "via": "bundle-search"
        },
        "2e7175ac5c": {
          "absolutePath": "/APP/node_modules/next/src/client/components/http-access-fallback/error-boundary.tsx",
          "column": 8,
          "compiled": {
            "column": 0,
            "line": 2624,
            "url": "http://localhost:3000/_next/static/chunks/node_modules_next_dist_client_0_90u2t._.js"
          },
          "dependency": true,
          "line": 154,
          "name": "HTTPAccessFallbackBoundary",
          "source": "/APP/node_modules/next/src/client/components/http-access-fallback/error-boundary.tsx",
          "status": "resolved",
          "via": "bundle-search"
        },
        "1a9c4d2131": {
          "absolutePath": "/APP/node_modules/next/src/client/components/http-access-fallback/error-boundary.tsx",
          "column": 1,
          "compiled": {
            "column": 0,
            "line": 2546,
            "url": "http://localhost:3000/_next/static/chunks/node_modules_next_dist_client_0_90u2t._.js"
          },
          "dependency": true,
          "line": 44,
          "name": "HTTPAccessFallbackErrorBoundary",
          "source": "/APP/node_modules/next/src/client/components/http-access-fallback/error-boundary.tsx",
          "status": "resolved",
          "via": "bundle-search"
        },
        "db9f129121": {
          "absolutePath": "/APP/node_modules/next/src/client/components/redirect-boundary.tsx",
          "column": 8,
          "compiled": {
            "column": 0,
            "line": 3882,
            "url": "http://localhost:3000/_next/static/chunks/node_modules_next_dist_client_0_90u2t._.js"
          },
          "dependency": true,
          "line": 81,
          "name": "RedirectBoundary",
          "source": "/APP/node_modules/next/src/client/components/redirect-boundary.tsx",
          "status": "resolved",
          "via": "bundle-search"
        },
        "2c24ad1606": {
          "absolutePath": "/APP/node_modules/next/src/client/components/redirect-boundary.tsx",
          "column": 8,
          "compiled": {
            "column": 0,
            "line": 3838,
            "url": "http://localhost:3000/_next/static/chunks/node_modules_next_dist_client_0_90u2t._.js"
          },
          "dependency": true,
          "line": 38,
          "name": "RedirectErrorBoundary",
          "source": "/APP/node_modules/next/src/client/components/redirect-boundary.tsx",
          "status": "resolved",
          "via": "bundle-search"
        },
        "5f06a63585": {
          "absolutePath": "/APP/node_modules/next/src/client/components/layout-router.tsx",
          "column": 1,
          "compiled": {
            "column": 4,
            "line": 666,
            "url": "http://localhost:3000/_next/static/chunks/node_modules_next_dist_20wefz_._.js"
          },
          "dependency": true,
          "line": 491,
          "name": "InnerLayoutRouter",
          "source": "/APP/node_modules/next/src/client/components/layout-router.tsx",
          "status": "resolved",
          "via": "bundle-search"
        },
        "n4a762f6d": {
          "detail": "React exposed no function for this component, so there was nothing to search for.",
          "name": "LayoutRouterContext",
          "status": "skipped"
        },
        "f16b9cd929": {
          "absolutePath": "/APP/node_modules/next/src/next-devtools/userspace/app/segment-explorer-node.tsx",
          "column": 8,
          "compiled": {
            "column": 0,
            "line": 1932,
            "url": "http://localhost:3000/_next/static/chunks/node_modules_next_dist_1e8vcs8._.js"
          },
          "dependency": true,
          "line": 100,
          "name": "SegmentViewNode",
          "source": "/APP/node_modules/next/src/next-devtools/userspace/app/segment-explorer-node.tsx",
          "status": "resolved",
          "via": "bundle-search"
        },
        "85d3f5e1f1": {
          "absolutePath": "/APP/app/components/ClientPanel.tsx",
          "column": 16,
          "compiled": {
            "column": 0,
            "line": 51,
            "url": "http://localhost:3000/_next/static/chunks/_1bb0xyr._.js"
          },
          "line": 5,
          "name": "ClientPanel",
          "source": "/APP/app/components/ClientPanel.tsx",
          "status": "resolved",
          "via": "bundle-search"
        },
        "5b61c9d4e4": {
          "absolutePath": "/APP/app/components/CheckoutButton.tsx",
          "column": 16,
          "compiled": {
            "column": 0,
            "line": 14,
            "url": "http://localhost:3000/_next/static/chunks/_1bb0xyr._.js"
          },
          "line": 5,
          "name": "CheckoutButton",
          "source": "/APP/app/components/CheckoutButton.tsx",
          "status": "resolved",
          "via": "bundle-search"
        },
        "3f5ade7c6c": {
          "absolutePath": "/APP/node_modules/next/src/client/components/render-from-template-context.tsx",
          "column": 16,
          "compiled": {
            "column": 0,
            "line": 1038,
            "url": "http://localhost:3000/_next/static/chunks/node_modules_next_dist_20wefz_._.js"
          },
          "dependency": true,
          "line": 6,
          "name": "RenderFromTemplateContext",
          "source": "/APP/node_modules/next/src/client/components/render-from-template-context.tsx",
          "status": "resolved",
          "via": "bundle-search"
        },
        "e753550010": {
          "absolutePath": "/APP/node_modules/next/src/client/components/layout-router.tsx",
          "column": 1,
          "compiled": {
            "column": 0,
            "line": 649,
            "url": "http://localhost:3000/_next/static/chunks/node_modules_next_dist_20wefz_._.js"
          },
          "dependency": true,
          "line": 466,
          "name": "ScrollAndMaybeFocusHandler",
          "source": "/APP/node_modules/next/src/client/components/layout-router.tsx",
          "status": "resolved",
          "via": "bundle-search"
        }
      }
    }
  };

/**
 * The same three clicks against `next build && next start`, reduced to the one
 * that matters — the click on the server-rendered div — with the React half
 * dropped, because what this flow is here to show is the RSC answer.
 */
const prodFlow = {
    "schemaVersion": 1,
    "id": "rsc-real-prod",
    "name": "RSC Real App — next start",
    "timestamp": 1788519600000,
    "startUrl": "http://localhost:3001/",
    "steps": [
      {
        "type": "click",
        "url": "http://localhost:3001/",
        "timestamp": 1788519602000,
        "action": "Clicked \"#server-panel\"",
        "stepNumber": 1,
        "element": {
          "tag": "div",
          "label": "ServerOnlyPanel",
          "cssSelector": "#server-panel",
          "xpath": "//*[@id=\"server-panel\"]",
          "boundingBox": null,
          "frameworks": [
            {
              "chain": [
                "60d235a818",
                "ca1d0bb747",
                "3b301b9eae",
                "6126f71383",
                "82d2334e7e",
                "8595c8b686",
                "ba48bd80d0"
              ],
              "framework": "rsc"
            }
          ]
        }
      }
    ],
    "rsc": {
      "detected": true,
      "version": "16.3.4",
      "build": "production",
      "components": {
        "3b301b9eae": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "i",
          "status": "pending"
        },
        "6126f71383": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "s",
          "status": "pending"
        },
        "82d2334e7e": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "h",
          "status": "pending"
        },
        "8595c8b686": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "d",
          "status": "pending"
        },
        "ba48bd80d0": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "x",
          "status": "pending"
        },
        "ca1d0bb747": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "R",
          "status": "pending"
        }
      }
    }
  };

/**
 * The second click again, with the component table **as it stood immediately
 * after that step** rather than as it stood at the end of the recording.
 *
 * This is the control for `frameworkComponents` being clobbered rather than
 * merged: same step, same chain, same ids — the only difference is that the
 * table still holds them.
 */
const devStep2Flow = {
    "schemaVersion": 1,
    "id": "rsc-real-dev-step2",
    "name": "RSC Real App — next dev, table as it stood after step 2",
    "timestamp": 1788519600000,
    "startUrl": "http://localhost:3000/",
    "steps": [
      {
        "type": "click",
        "url": "http://localhost:3000/",
        "timestamp": 1788519602000,
        "action": "Clicked \"#server-panel\"",
        "stepNumber": 1,
        "element": {
          "tag": "div",
          "label": "ServerOnlyPanel",
          "cssSelector": "#server-panel",
          "xpath": "//*[@id=\"server-panel\"]",
          "boundingBox": null,
          "frameworks": [
            {
              "chain": [
                "4af7b53525",
                "c0c6011d2d",
                "2e7175ac5c",
                "1a9c4d2131",
                "db9f129121",
                "2c24ad1606",
                "5f06a63585",
                "f16b9cd929",
                "ne83d9196",
                "649e8554e4"
              ],
              "framework": "rsc"
            }
          ],
          "react": {
            "chain": [
              "3f5ade7c6c",
              "e753550010",
              "98ff6986b6",
              "4af7b53525",
              "c0c6011d2d",
              "2e7175ac5c",
              "1a9c4d2131",
              "db9f129121",
              "2c24ad1606",
              "5f06a63585",
              "n4a762f6d",
              "f16b9cd929"
            ],
            "truncated": true
          }
        }
      }
    ],
    "rsc": {
      "detected": true,
      "version": "16.3.4",
      "build": "development",
      "components": {
        "4af7b53525": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "ErrorBoundary",
          "status": "pending"
        },
        "c0c6011d2d": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "LoadingBoundary",
          "status": "pending"
        },
        "2e7175ac5c": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "HTTPAccessFallbackBoundary",
          "status": "pending"
        },
        "1a9c4d2131": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "HTTPAccessFallbackErrorBoundary",
          "status": "pending"
        },
        "db9f129121": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "RedirectBoundary",
          "status": "pending"
        },
        "2c24ad1606": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "RedirectErrorBoundary",
          "status": "pending"
        },
        "5f06a63585": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "InnerLayoutRouter",
          "status": "pending"
        },
        "f16b9cd929": {
          "detail": "The runtime exposed this component as a function but did not say where it was written. Finding it needs a bundle search, which is not yet wired for this framework.",
          "name": "SegmentViewNode",
          "status": "pending"
        },
        "ne83d9196": {
          "detail": "Page ran on the server and this build named it without a source frame, so there is no file to open. Its props and owner chain are still readable.",
          "name": "Page",
          "status": "not-found"
        },
        "649e8554e4": {
          "column": 264,
          "line": 154,
          "name": "ServerOnlyPanel",
          "source": "/APP/.next/dev/server/chunks/ssr/[root-of-the-server]__1yg-s_y._.js",
          "status": "resolved",
          "via": "debug-source"
        }
      }
    }
  };

/** The inline flight payload `next start` served, read out of the `<script>` tags. */
const PROD_FLIGHT: string[] = [
    "1:\"$Sreact.fragment\"\n2:I[39756,[\"/_next/static/chunks/3fntmmi971322.js\"],\"default\"]\n3:I[37457,[\"/_next/static/chunks/3fntmmi971322.js\"],\"default\"]\n4:I[12177,[\"/_next/static/chunks/3fntmmi971322.js\",\"/_next/static/chunks/1e0p9l01qr10t.js\"],\"default\"]\n5:\"$Sreact.suspense\"\n7:I[97367,[\"/_next/static/chunks/3fntmmi971322.js\"],\"OutletBoundary\"]\n9:I[97367,[\"/_next/static/chunks/3fntmmi971322.js\"],\"ViewportBoundary\"]\nb:I[97367,[\"/_next/static/chunks/3fntmmi971322.js\"],\"MetadataBoundary\"]\nd:I[68027,[\"/_next/static/chunks/3fntmmi971322.js\"],\"default\",1]\n0:{\"P\":null,\"c\":[\"\",\"\"],\"q\":\"\",\"i\":false,\"f\":[[[\"\",{\"children\":[\"__PAGE__\",{},\"$undefined\",\"$undefined\",4096]},\"$undefined\",\"$undefined\",4112],[[\"$\",\"$1\",\"c\",{\"children\":[[[\"$\",\"script\",\"script-0\",{\"src\":\"/_next/static/chunks/3fntmmi971322.js\",\"async\":true,\"nonce\":\"$undefined\"}]],[\"$\",\"html\",null,{\"lang\":\"en\",\"children\":[\"$\",\"body\",null,{\"children\":[\"$\",\"$L2\",null,{\"parallelRouterKey\":\"children\",\"error\":\"$undefined\",\"errorStyles\":\"$undefined\",\"errorScripts\":\"$undefined\",\"template\":[\"$\",\"$L3\",null,{}],\"templateStyles\":\"$undefined\",\"templateScripts\":\"$undefined\",\"notFound\":[[[\"$\",\"title\",null,{\"children\":\"404: This page could not be found.\"}],[\"$\",\"div\",null,{\"style\":{\"fontFamily\":\"system-ui,\\\"Segoe UI\\\",Roboto,Helvetica,Arial,sans-serif,\\\"Apple Color Emoji\\\",\\\"Segoe UI Emoji\\\"\",\"height\":\"100vh\",\"textAlign\":\"center\",\"display\":\"flex\",\"flexDirection\":\"column\",\"alignItems\":\"center\",\"justifyContent\":\"center\"},\"children\":[\"$\",\"div\",null,{\"children\":[[\"$\",\"style\",null,{\"dangerouslySetInnerHTML\":{\"__html\":\"body{color:#000;background:#fff;margin:0}.next-error-h1{border-right:1px solid rgba(0,0,0,.3)}@media (prefers-color-scheme:dark){body{color:#fff;background:#000}.next-error-h1{border-right:1px solid rgba(255,255,255,.3)}}\"}}],[\"$\",\"h1\",null,{\"className\":\"next-error-h1\",\"style\":{\"display\":\"inline-block\",\"margin\":\"0 20px 0 0\",\"padding\":\"0 23px 0 0\",\"fontSize\":24,\"fontWeight\":500,\"verticalAlign\":\"top\",\"lineHeight\":\"49px\"},\"children\":404}],[\"$\",\"div\",null,{\"style\":{\"display\":\"inline-block\"},\"children\":[\"$\",\"h2\",null,{\"style\":{\"fontSize\":14,\"fontWeight\":400,\"lineHeight\":\"49px\",\"margin\":0},\"children\":\"This page could not be found.\"}]}]]}]}]],[]],\"forbidden\":\"$undefined\",\"unauthorized\":\"$undefined\"}]}]}]]}],{\"children\":[[\"$\",\"$1\",\"c\",{\"children\":[[\"$\",\"main\",null,{\"id\":\"page-main\",\"children\":[[\"$\",\"h1\",null,{\"children\":\"RSC Real App\"}],[\"$\",\"div\",null,{\"id\":\"server-panel\",\"data-computed\":30,\"data-label\":\"from-page\",\"children\":[[\"$\",\"h2\",null,{\"children\":\"ServerOnlyPanel\"}],[\"$\",\"p\",null,{\"id\":\"server-text\",\"children\":\"marker=RSC_REAL_SERVER_RENDERED_TEXT\"}]]}],[\"$\",\"$L4\",null,{\"title\":\"Cart\"}],[\"$\",\"$5\",null,{\"fallback\":[\"$\",\"div\",null,{\"id\":\"slow-fallback\",\"children\":\"LOADING_RSC_REAL_FALLBACK\"}],\"children\":\"$L6\"}]]}],[[\"$\",\"script\",\"script-0\",{\"src\":\"/_next/static/chunks/1e0p9l01qr10t.js\",\"async\":true,\"nonce\":\"$undefined\"}]],[\"$\",\"$L7\",null,{\"children\":[\"$\",\"$5\",null,{\"name\":\"Next.MetadataOutlet\",\"children\":\"$@8\"}]}]]}],{},null,false,null]},null,false,null],[\"$\",\"$1\",\"h\",{\"children\":[null,[\"$\",\"$L9\",null,{\"children\":\"$La\"}],[\"$\",\"div\",null,{\"hidden\":true,\"children\":[\"$\",\"$Lb\",null,{\"children\":[\"$\",\"$5\",null,{\"name\":\"Next.Metadata\",\"children\":\"$Lc\"}]}]}],null]}],false]],\"m\":\"$undefined\",\"G\":[\"$d\",[]],\"S\":false,\"h\":null,\"r\":\"$undefined\",\"s\":\"$undefined\",\"a\":\"$undefined\",\"l\":\"$undefined\",\"p\":\"$undefined\",\"d\":\"$undefined\",\"b\":\"YVGKBn36UaUt18KauQ1Yv\"}\na:[[\"$\",\"meta\",\"0\",{\"charSet\":\"utf-8\"}],[\"$\",\"meta\",\"1\",{\"name\":\"viewport\",\"content\":\"width=device-width, initial-scale=1\"}]]\n8:null\nc:[[\"$\",\"title\",\"0\",{\"children\":\"RSC Real App\"}]]\n",
    "6:[\"$\",\"div\",null,{\"id\":\"slow-server-data\",\"children\":[[\"$\",\"h2\",null,{\"children\":\"SlowServerData\"}],[\"$\",\"p\",null,{\"children\":\"marker=RSC_REAL_SUSPENDED_PAYLOAD_ARRIVED\"}]]}]\n"
  ];

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-rsc-e2e-'));
  server = await startServer({ home });

  for (const flow of [devFlow, prodFlow, devStep2Flow]) {
    const posted = await server.post('/flows', JSON.stringify(flow));
    expect(posted.status).toBe(200);
  }
}, 30_000);

afterAll(() => {
  server?.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * A flow as `saveFlow` left it. Loosely typed on purpose: the point of reading
 * it back is to see what is *there*, including the keys the payload sent and
 * the copy dropped, which a shape declared up here would hide.
 */
interface DiskFlow {
  steps: { element: { frameworks: { chain: string[] }[] } }[];
  react?: { build: string; components: Record<string, { name: string }> };
  rsc?: {
    detected: boolean;
    build: string;
    version: string;
    components: Record<string, { name: string; status: string; via?: string; detail?: string }>;
  };
}

const onDisk = (id: string): DiskFlow =>
  JSON.parse(fs.readFileSync(path.join(home, 'flows', id, 'flow.json'), 'utf8')) as DiskFlow;

const detail = (id: string, step: number): Promise<string> =>
  server.call('get_step_detail', { id, step, include: ['component'] });

describe('the rsc table survives the by-name copy in saveFlow', () => {
  /*
   * Read off disk rather than out of a reply, for `framework-end-to-end`'s
   * reason: a renderer that reconstructed the names would answer correctly for a
   * flow that had lost the table entirely.
   */
  it('writes the flow-level rsc table', () => {
    const flow = onDisk('rsc-real-dev');

    expect(flow.rsc).toBeDefined();
    expect(flow.rsc!.detected).toBe(true);
    expect(flow.rsc!.build).toBe('development');
    expect(flow.rsc!.version).toBe('16.3.4');
    expect(flow.rsc!.components['928c8ff040'].name).toBe('SlowServerData');
  });

  /*
   * A Next.js page is React *and* RSC, which is why `FlowPayload` has separate
   * keys rather than one discriminant. Both halves have to reach disk, or the
   * claim that the two are read independently is untested.
   */
  it('keeps the react table beside it, because the page is genuinely both', () => {
    const flow = onDisk('rsc-real-dev');

    expect(flow.react).toBeDefined();
    expect(flow.react!.build).toBe('development');
    expect(flow.react!.components['5b61c9d4e4'].name).toBe('CheckoutButton');
    expect(flow.rsc!.detected).toBe(true);
  });

  it('keeps the production recording’s rsc table too', () => {
    const flow = onDisk('rsc-real-prod');

    expect(flow.rsc!.build).toBe('production');
    expect(flow.rsc!.version).toBe('16.3.4');
  });
});

describe('what a dev recording says about one click', () => {
  /*
   * The dual answer, in one reply. React resolves the click to the `.tsx` a
   * person can open; RSC answers the same element from `fiber._debugInfo` and
   * gets as far as `Page`. Neither is a substitute for the other, and this is
   * the assertion that they arrive together rather than one shadowing the other.
   */
  it('answers a client-component click with both React and RSC', async () => {
    const answer = await detail('rsc-real-dev', 1);

    expect(answer).toContain('CheckoutButton  /APP/app/components/CheckoutButton.tsx:5');
    expect(answer).toContain('rsc: Page');
    expect(answer).toContain(
      'rsc chain, outermost first: HTTPAccessFallbackErrorBoundary › RedirectBoundary › ' +
        'RedirectErrorBoundary › InnerLayoutRouter › SegmentViewNode › Page',
    );
  });

  /*
   * `Page`'s own `_debugInfo` record carries `stack: [["Promise.all","",0,0,0,0,true]]`
   * — a frame with an empty file — so `resolutionFor` refuses to call it
   * `declared`. That refusal reaches the reader intact, which is the whole point
   * of `AbsentReason` carrying a sentence.
   */
  it('says why the root server component has no file, rather than inventing one', async () => {
    const answer = await detail('rsc-real-dev', 1);

    expect(answer).toContain(
      'Page ran on the server and this build named it without a source frame, so there is ' +
        'no file to open. Its props and owner chain are still readable.',
    );
  });

  /*
   * A server component nested in a Suspense boundary, named off the fiber, with
   * a position — and the position is in the **compiled dev SSR chunk**, not in
   * `SlowServerData.tsx`.
   *
   * `core/rsc/debug.ts` says in as many words that turning the chunk into the
   * `.tsx` needs `/__nextjs_source-map` fetched by somebody impure, and provides
   * `devSourceMapUrl` and `resolveDeclaredThrough` to do it. Nothing in `src/`
   * calls either — only `tests/rsc-adapter.test.ts` does — so a real dev
   * recording ships a path into build output. That is what this pins.
   */
  it('names a suspended server component, and points at build output rather than source', async () => {
    const answer = await detail('rsc-real-dev', 3);

    expect(answer).toContain('rsc: SlowServerData');
    expect(answer).toContain(
      '/APP/.next/dev/server/chunks/ssr/[root-of-the-server]__1yg-s_y._.js:177',
    );
    // The `.tsx` the component was written in is nowhere in the reply.
    expect(answer).not.toContain('SlowServerData.tsx');
  });

  /*
   * FIXED — `src/core/rsc/debug.ts`.
   *
   * `attributionFrame` documents at length that the frame it returns is the
   * **call site**: `SlowServerData`'s frame is named `Page`, because that is
   * where `<SlowServerData/>` was written. `Resolution.at` exists precisely so
   * that can be said out loud, and `resolutionSource` turns `at: 'call-site'`
   * into a sentence. `resolutionFor` never set it, so the sentence was dead
   * code and a call site shipped indistinguishable from a declaration.
   *
   * Asserted against the live resolver rather than the recording, because the
   * recording was made before the fix and cannot show it.
   */
  it('marks a server component’s frame as the call site it is', () => {
    const adapter = createRscAdapter({
      flightChunks: () => [],
      readingsFor: () => [
        {
          name: null,
          host: true,
          debugInfo: [
            {
              name: 'SlowServerData',
              env: 'Server',
              stack: [['Page', '/app/page.tsx', 12, 7, 0, 0, false]],
            },
          ],
          fnSource: null,
        },
      ],
      describe: () => ({ tag: 'div', attributes: {} }),
      version: () => '16.3.4',
    });

    const declared = (adapter.fromElement({} as Element)?.chain ?? []).find(
      (r) => r.kind === 'declared',
    );
    expect(declared?.kind === 'declared' && declared.at).toBe('call-site');
  });
});

describe('production, where the honest answer is that there is no answer', () => {
  /*
   * The mechanism works. Handed the flight payload `next start` actually served
   * and a fiber walk that found nothing — which is what a server-rendered
   * `<div>`'s ancestors would be if Next did not wrap every page in its own
   * client components — the adapter finds the element's markup on the wire and
   * returns `absent` / `server-rendered` with the sentence that names the MCP
   * server as the only thing that can do better.
   */
  it('resolves a production server component to absent, server-rendered, with a reason', () => {
    const adapter = createRscAdapter({
      flightChunks: () => PROD_FLIGHT,
      readingsFor: () => [{ name: null, host: true, debugInfo: undefined, fnSource: null }],
      describe: () => ({
        tag: 'div',
        attributes: { id: 'server-panel', 'data-computed': '30', 'data-label': 'from-page' },
      }),
      version: () => '16.3.4',
    });

    expect(adapter.detect()).toEqual({
      framework: 'rsc',
      detected: true,
      build: 'production',
      version: '16.3.4',
    });

    const resolved = adapter.fromElement({} as Element);
    expect(resolved?.chain).toHaveLength(1);
    const [only] = resolved!.chain;
    expect(only.kind).toBe('absent');
    expect(only.kind === 'absent' && only.reason).toBe('server-rendered');
    expect(only.kind === 'absent' && only.detail).toContain(
      'This markup is in the flight payload, so a server component rendered it.',
    );
  });

  /*
   * FIXED — `src/core/rsc/adapter.ts`, guard rewritten.
   *
   * The arm above used to run only `if (chain.length === 0 && …)`, and on a real
   * App Router page the chain is never empty: every element sits under Next's
   * own client boundaries — `LayoutRouter`, `RedirectBoundary`,
   * `ErrorBoundary` — which are ordinary functions in the production bundle and
   * each yield a `searchable`. Seven were measured on one page. The branch was
   * unreachable on exactly the page it was written for, and a click on
   * server-rendered markup answered with a minified letter.
   *
   * The guard now asks whether the chain holds a real *identity* — a `declared`
   * resolution — rather than whether it is empty, and reaches the production
   * answer whenever the element's own markup is on the wire. Next's wrappers are
   * ancestors of the element, not the thing that rendered it, so they no longer
   * suppress the one true statement available about it.
   */
  it('reaches that answer through Next’s own wrappers, which are only ancestors', () => {
    const wrappers = ['x', 'd', 'h', 's'].map((name) => ({
      name,
      host: false,
      debugInfo: undefined,
      fnSource: `function ${name}(){return null}`,
    }));

    const adapter = createRscAdapter({
      flightChunks: () => PROD_FLIGHT,
      // The element's own host fiber, then four of Next's minified boundaries.
      readingsFor: () => [
        { name: null, host: true, debugInfo: undefined, fnSource: null },
        ...wrappers,
      ],
      describe: () => ({
        tag: 'div',
        attributes: { id: 'server-panel', 'data-computed': '30', 'data-label': 'from-page' },
      }),
      version: () => '16.3.4',
    });

    const resolved = adapter.fromElement({} as Element);
    const absences = (resolved?.chain ?? []).filter((r) => r.kind === 'absent');

    expect(absences).toHaveLength(1);
    expect(absences[0].kind === 'absent' && absences[0].reason).toBe('server-rendered');
    // The wrappers are still reported — they are real ancestors, just not the
    // renderer — so the fix adds an answer rather than replacing four.
    expect((resolved?.chain ?? []).filter((r) => r.kind === 'searchable')).toHaveLength(4);
  });

  /*
   * The other half of the same guard: `stripped-by-build` must NOT be appended
   * beside real client components. When the markup is not on the wire, the
   * searchable entries are the answer — unresolved, but not absent.
   */
  it('stays quiet when the markup is not on the wire and something was found', () => {
    const adapter = createRscAdapter({
      flightChunks: () => PROD_FLIGHT,
      readingsFor: () => [
        { name: null, host: true, debugInfo: undefined, fnSource: null },
        { name: 'q', host: false, debugInfo: undefined, fnSource: 'function q(){return null}' },
      ],
      describe: () => ({ tag: 'div', attributes: { id: 'not-on-the-wire-at-all' } }),
      version: () => '16.3.4',
    });

    const resolved = adapter.fromElement({} as Element);
    expect((resolved?.chain ?? []).some((r) => r.kind === 'absent')).toBe(false);
  });
});
