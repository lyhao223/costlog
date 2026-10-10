// Preloaded by tests: any attempt to open a socket, resolve a host or fetch fails loudly.
import dns from 'node:dns';
import net from 'node:net';

const deny = (what) => () => {
  throw new Error(`network access attempted: ${what}`);
};
net.Socket.prototype.connect = deny('socket');
dns.lookup = deny('dns.lookup');
dns.promises.lookup = deny('dns.promises.lookup');
globalThis.fetch = deny('fetch');
