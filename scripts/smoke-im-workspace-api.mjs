import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const plugin = process.argv[2];
if (!plugin) throw new Error("Pass the installed IM plugin directory");
const { ChannelManager } = await import(
  pathToFileURL(resolve(plugin, "lib/manager.js"))
);
let projects = [
  { id: "existing", name: "已有项目", cwd: "C:\\private\\workspace\\已有项目" },
];
let handler;
let reads = 0;
const manager = Object.assign(Object.create(ChannelManager.prototype), {
  ctx: {
    get: (name) => {
      assert.equal(name, "workagentChannels");
      return {
        projects: () => {
          reads++;
          return projects;
        },
      };
    },
  },
  apiDisposers: [],
  log() {},
});
manager.registerApi({
  webServer: {
    register: (route) => {
      handler = route.handler;
    },
  },
});
async function request(method = "GET", remoteAddress = "127.0.0.1") {
  let status;
  let body;
  await handler(
    {
      method,
      url: "/dsh-im-connect/api/projects",
      socket: { remoteAddress },
      headers: {
        host: "127.0.0.1",
        "x-dsh-im-connect-client": "1",
        "content-type": "application/json",
      },
    },
    {
      writeHead: (value) => {
        status = value;
      },
      end: (value) => {
        body = JSON.parse(value);
      },
    },
  );
  return { status, body };
}
assert.deepEqual(await request(), {
  status: 200,
  body: { ok: true, projects },
});
projects = [];
assert.deepEqual(await request(), {
  status: 200,
  body: { ok: true, projects: [] },
});
assert.equal((await request("POST")).status, 405);
assert.equal((await request("GET", "203.0.113.5")).status, 403);
assert.equal(reads, 2);
console.log(
  "PASS IM projects API uses unified project service, preserves cwd, supports empty lists, rejects writes and untrusted access",
);
