import type { BodyReader, HTTPReq, HTTPRes } from "./http_types.js";

/** Only these methods are registered on the router; others never match. */
export type HttpMethod = "GET" | "POST" | "HEAD";

export type RouteParams = Record<string, string>;

export type RouteHandler = (
  req: HTTPReq,
  body: BodyReader,
  params: RouteParams
) => Promise<HTTPRes>;

type MethodHandlers = Partial<Record<HttpMethod, RouteHandler>>;

/**
 * Segment radix trie: each edge is one URL path segment (text between `/`).
 * At each node: static children, optional `:param` child, optional trailing `*` wildcard.
 * Matching order: static → param → wildcard.
 */
type TrieNode = {
  static: Map<string, TrieNode>;
  param: { name: string; child: TrieNode } | undefined;
  wildcard: { name: string; handlers: MethodHandlers } | undefined;
  /** Handler when the path ends exactly at this node. */
  exact: MethodHandlers;
};

function splitRoute(pathOrPattern: string): string[] {
  const p = pathOrPattern.trim();
  if (!p || p === "/") return [];
  return p.split("/").filter(Boolean);
}

function parsePattern(pattern: string): string[] {
  const t = pattern.trim();
  if (!t.startsWith("/")) {
    throw new Error(`Route pattern must start with "/": ${pattern}`);
  }
  return splitRoute(t);
}

function assertValidPatternSegments(segments: string[]): void {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s === "*") {
      if (i !== segments.length - 1) {
        throw new Error(`"*" must be the last segment in pattern: ${segments.join("/")}`);
      }
    } else if (s.startsWith(":")) {
      const name = s.slice(1);
      if (!name) throw new Error(`Empty param name in segment: ${s}`);
      if (name.includes("*")) throw new Error(`Invalid param segment: ${s}`);
    }
  }
}

function mergeHandlers(
  target: MethodHandlers,
  method: HttpMethod,
  handler: RouteHandler
): void {
  target[method] = handler;
}

function getOrCreateStatic(parent: TrieNode, seg: string): TrieNode {
  let n = parent.static.get(seg);
  if (!n) {
    n = emptyNode();
    parent.static.set(seg, n);
  }
  return n;
}

function emptyNode(): TrieNode {
  return {
    static: new Map(),
    param: undefined,
    wildcard: undefined,
    exact: {},
  };
}

const DEFAULT_WILDCARD_PARAM = "wildcard";

export class Router {
  private readonly root: TrieNode = emptyNode();

  get(pattern: string, handler: RouteHandler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add("POST", pattern, handler);
  }

  head(pattern: string, handler: RouteHandler): this {
    return this.add("HEAD", pattern, handler);
  }

  add(method: HttpMethod, pattern: string, handler: RouteHandler): this {
    const segments = parsePattern(pattern);
    assertValidPatternSegments(segments);
    let node = this.root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg === "*") {
        const name = DEFAULT_WILDCARD_PARAM;
        if (!node.wildcard) {
          node.wildcard = { name, handlers: {} };
        } else if (node.wildcard.name !== name) {
          throw new Error(`Conflicting wildcard param name on same node`);
        }
        mergeHandlers(node.wildcard.handlers, method, handler);
        return this;
      }
      if (seg.startsWith(":")) {
        const name = seg.slice(1);
        if (!node.param) {
          node.param = { name, child: emptyNode() };
        } else if (node.param.name !== name) {
          throw new Error(
            `Conflicting :param names at same position: :${node.param.name} vs :${name}`
          );
        }
        node = node.param.child;
        continue;
      }
      node = getOrCreateStatic(node, seg);
    }
    mergeHandlers(node.exact, method, handler);
    return this;
  }

  /**
   * Returns a handler and captured params, or null if nothing matches `method` + `pathname`.
   * `pathname` should be the path only (e.g. from `urlPathname(req.uri)`), leading slash optional.
   */
  match(
    method: string,
    pathname: string
  ): { handler: RouteHandler; params: RouteParams } | null {
    const m = method.toUpperCase();
    if (m !== "GET" && m !== "POST" && m !== "HEAD") return null;

    const pathSegs = splitRoute(pathname.startsWith("/") ? pathname : `/${pathname}`);

    const walk = (
      node: TrieNode,
      i: number,
      params: RouteParams
    ): { handler: RouteHandler; params: RouteParams } | null => {
      if (i >= pathSegs.length) {
        const h = node.exact[m as HttpMethod];
        if (h) return { handler: h, params };
        if (node.wildcard) {
          const wh = node.wildcard.handlers[m as HttpMethod];
          if (wh) {
            return {
              handler: wh,
              params: { ...params, [node.wildcard.name]: "" },
            };
          }
        }
        return null;
      }

      const seg = pathSegs[i]!;
      if (node.static.has(seg)) {
        return walk(node.static.get(seg)!, i + 1, params);
      }
      if (node.param) {
        const next = { ...params, [node.param.name]: seg };
        const r = walk(node.param.child, i + 1, next);
        if (r) return r;
      }
      if (node.wildcard) {
        const wh = node.wildcard.handlers[m as HttpMethod];
        if (wh) {
          const tail = pathSegs.slice(i).join("/");
          return {
            handler: wh,
            params: { ...params, [node.wildcard.name]: tail },
          };
        }
      }
      return null;
    };

    return walk(this.root, 0, {});
  }
}
