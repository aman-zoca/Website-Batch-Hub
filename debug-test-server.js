const http = require('http');

// This code runs right away — put a RED DOT on line 5, 6, or 7
const name = 'Aman';
const age = 25;
const info = { name, age, lang: 'JavaScript' };
console.log('info:', info);

const server = http.createServer((req, res) => {
  const url = req.url;
  const method = req.method;
  const headers = req.headers;

  // Stops on every request — hover url, method, headers to see values
  console.log(`${method} ${url}`);

  if (url === '/') {
    const message = 'Hello from debug server';
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(message);

  } else if (url === '/data') {
    const data = {
      name: 'Test User',
      timestamp: Date.now(),
      items: [1, 2, 3, 4, 5],
      nested: { a: 10, b: 20 }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));

  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

const PORT = 3099;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
