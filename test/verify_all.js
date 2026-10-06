const http = require('http');

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {
          json = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: json,
          rawBody: data
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      const bodyData = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      req.write(bodyData);
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('=== STARTING ALL 13 REQUIREMENTS VERIFICATION ===\n');

  // Req 12: Clear cache first to start clean
  console.log('--- Clearing cache to start clean ---');
  await request('http://localhost:8081/api/cache/clear', { method: 'DELETE' });
  await sleep(500);

  // Requirement 3: Nginx Load Balancing
  console.log('--- Test Req 3: Nginx Round Robin ---');
  const instanceIds = [];
  for (let i = 0; i < 3; i++) {
    const res = await request('http://localhost:80/api/instance/id');
    console.log(`Request ${i + 1} to port 80 -> ${res.data}`);
    instanceIds.push(res.data);
  }
  const uniqueInstances = new Set(instanceIds);
  console.log('Unique instances via Nginx:', Array.from(uniqueInstances));
  if (uniqueInstances.size === 3) {
    console.log(' Req 3 PASSED: All 3 instances reached via Nginx round-robin\n');
  } else {
    console.error('❌ Req 3 FAILED: Expected 3 distinct instances\n');
  }

  // Requirement 4: Direct instance endpoints
  console.log('--- Test Req 4: Direct Instance ID ---');
  const id1 = await request('http://localhost:8081/api/instance/id');
  const id2 = await request('http://localhost:8082/api/instance/id');
  const id3 = await request('http://localhost:8083/api/instance/id');
  console.log(`Port 8081: ${id1.data}, Port 8082: ${id2.data}, Port 8083: ${id3.data}`);
  if (id1.data === 'instance-1' && id2.data === 'instance-2' && id3.data === 'instance-3') {
    console.log(' Req 4 PASSED: Instance IDs match correctly\n');
  } else {
    console.error('❌ Req 4 FAILED\n');
  }

  // Requirement 5: Two-level cache-aside logic
  console.log('--- Test Req 5: Cache-aside on GET /api/products/1 ---');
  // First clear to ensure product 1 is fresh
  await request('http://localhost:8081/api/cache/invalidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { key: 'product:1' }
  });
  await sleep(300);

  const get1 = await request('http://localhost:8081/api/products/1');
  console.log('First GET (app1): X-Cache =', get1.headers['x-cache'], 'Body:', get1.data);
  const get2 = await request('http://localhost:8081/api/products/1');
  console.log('Second GET (app1): X-Cache =', get2.headers['x-cache']);
  const get3 = await request('http://localhost:8082/api/products/1');
  console.log('Third GET (app2): X-Cache =', get3.headers['x-cache']);

  if (get1.headers['x-cache'] === 'MISS' &&
      get2.headers['x-cache'] === 'HIT-L1' &&
      get3.headers['x-cache'] === 'HIT-L2') {
    console.log(' Req 5 PASSED: MISS -> HIT-L1 -> HIT-L2 verified\n');
  } else {
    console.error('❌ Req 5 FAILED\n');
  }

  // Requirement 6 & 7 & 8: PUT invalidation & cross instance coherence
  console.log('--- Test Req 6, 7, 8: Cross-instance invalidation ---');
  // Prime product 2 on app1 and app2
  await request('http://localhost:8081/api/cache/invalidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { key: 'product:2' }
  });
  await sleep(300);

  const prime1 = await request('http://localhost:8081/api/products/2');
  console.log('Prime app1 (product 2): X-Cache =', prime1.headers['x-cache']);
  const prime1_hit = await request('http://localhost:8081/api/products/2');
  console.log('Confirm app1 HIT-L1: X-Cache =', prime1_hit.headers['x-cache']);
  const prime2_hit = await request('http://localhost:8082/api/products/2');
  console.log('Confirm app2 HIT-L2: X-Cache =', prime2_hit.headers['x-cache']);

  // Update product 2 via app3
  const newPrice = "850.75";
  const putRes = await request('http://localhost:8083/api/products/2', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: { name: 'Smartphone Pro Max', price: newPrice }
  });
  console.log('PUT app3 response:', putRes.statusCode, putRes.data);
  await sleep(500); // Give Pub/Sub a moment to propagate

  // Verify on app1
  const verify1 = await request('http://localhost:8081/api/products/2');
  console.log('Verify app1 after update: X-Cache =', verify1.headers['x-cache'], 'Price:', verify1.data.price);
  if (verify1.headers['x-cache'] === 'MISS' && verify1.data.name === 'Smartphone Pro Max') {
    console.log(' Req 8 (app1) PASSED: Old cache evicted, fresh data served on MISS');
  } else {
    console.error('❌ Req 8 (app1) FAILED');
  }

  // Requirement 9: Paginated list cache and invalidation on POST
  console.log('\n--- Test Req 9: List cache invalidation on POST ---');
  const list1 = await request('http://localhost:8081/api/products?page=1');
  console.log('Initial list fetch: X-Cache =', list1.headers['x-cache'], 'Items count =', list1.data.length);
  const list2 = await request('http://localhost:8081/api/products?page=1');
  console.log('Second list fetch (cached): X-Cache =', list2.headers['x-cache']);

  // Create new product
  const postRes = await request('http://localhost:8081/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { name: 'Super Tablet', description: 'OLED tablet', price: '499.00', stock: 30 }
  });
  console.log('POST product response:', postRes.statusCode, postRes.data);
  await sleep(500);

  const list3 = await request('http://localhost:8081/api/products?page=1');
  console.log('List fetch after POST: X-Cache =', list3.headers['x-cache'], 'New count =', list3.data.length);
  const hasNewProduct = list3.data.some(p => p.name === 'Super Tablet');
  if (list3.headers['x-cache'] === 'MISS' && hasNewProduct) {
    console.log(' Req 9 PASSED: List cache invalidated and new product returned\n');
  } else {
    console.error('❌ Req 9 FAILED\n');
  }

  // Requirement 10: Cache stats
  console.log('--- Test Req 10: Cache Stats Endpoint ---');
  const statsRes = await request('http://localhost:8081/api/cache/stats');
  console.log('Stats response:', statsRes.data);
  const s = statsRes.data;
  if (typeof s.instanceId === 'string' &&
      typeof s.l1_hits === 'number' &&
      typeof s.l1_misses === 'number' &&
      typeof s.l2_hits === 'number' &&
      typeof s.l2_misses === 'number' &&
      typeof s.db_hits === 'number' &&
      typeof s.total_requests === 'number' &&
      typeof s.hit_ratio === 'number') {
    console.log(' Req 10 PASSED: All stat metrics present and numeric\n');
  } else {
    console.error('❌ Req 10 FAILED\n');
  }

  // Requirement 11: Manual Invalidation
  console.log('--- Test Req 11: Manual Invalidation ---');
  await request('http://localhost:8081/api/products/3'); // prime
  const invRes = await request('http://localhost:8082/api/cache/invalidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { key: 'product:3' }
  });
  console.log('Manual invalidate response:', invRes.data);
  await sleep(300);
  const verifyInv = await request('http://localhost:8081/api/products/3');
  console.log('Read after manual invalidate: X-Cache =', verifyInv.headers['x-cache']);
  if (invRes.data.status === 'ok' && verifyInv.headers['x-cache'] === 'MISS') {
    console.log(' Req 11 PASSED: Manual invalidation succeeded across instances\n');
  } else {
    console.error('❌ Req 11 FAILED\n');
  }

  // Requirement 12: Clear All Caches
  console.log('--- Test Req 12: Clear All Caches ---');
  await request('http://localhost:8081/api/products/1'); // prime
  const clearRes = await request('http://localhost:8081/api/cache/clear', { method: 'DELETE' });
  console.log('Clear response:', clearRes.data);
  await sleep(300);
  const verifyClear = await request('http://localhost:8081/api/products/1');
  console.log('Read after clear: X-Cache =', verifyClear.headers['x-cache']);
  if (clearRes.data.status === 'ok' && verifyClear.headers['x-cache'] === 'MISS') {
    console.log(' Req 12 PASSED: Cache clear succeeded\n');
  } else {
    console.error('❌ Req 12 FAILED\n');
  }

  console.log('=== ALL TESTS COMPLETED ===');
}

runTests().catch(console.error);
