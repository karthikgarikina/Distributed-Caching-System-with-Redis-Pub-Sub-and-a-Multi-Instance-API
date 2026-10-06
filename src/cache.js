const Redis = require('ioredis');
const { LRUCache } = require('lru-cache');

const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
const instanceId = process.env.INSTANCE_ID || 'instance-1';

// L1 Cache: In-memory LRU
const l1 = new LRUCache({
  max: 1000,
  ttl: 1000 * 60 * 5 // 5 minutes TTL
});

// L2 Cache: Redis Client
const redis = new Redis(redisUrl, {
  retryStrategy(times) {
    return Math.min(times * 100, 3000);
  }
});

// Redis Subscriber for Invalidation
const redisSub = new Redis(redisUrl, {
  retryStrategy(times) {
    return Math.min(times * 100, 3000);
  }
});

const stats = {
  instanceId,
  l1_hits: 0,
  l1_misses: 0,
  l2_hits: 0,
  l2_misses: 0,
  db_hits: 0,
  total_requests: 0
};

// Helper to test if a key matches a glob-like pattern (e.g. products:page:*)
function matchPattern(key, pattern) {
  const regexStr = '^' + pattern.replace(/([.+?^=!:${}()|\[\]\/\\])/g, "\\$1").replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr).test(key);
}

// Subscribe to cache invalidation channel
redisSub.subscribe('cache-invalidation', (err) => {
  if (err) {
    console.error(`[${instanceId}] Failed to subscribe to cache-invalidation:`, err);
  } else {
    console.log(`[${instanceId}] Subscribed to cache-invalidation channel`);
  }
});

redisSub.on('message', (channel, messageStr) => {
  if (channel !== 'cache-invalidation') return;

  try {
    const message = JSON.parse(messageStr);
    console.log(`[${instanceId}] Received invalidation event:`, message);

    if (message.type === 'INVALIDATE_KEY' && message.key) {
      l1.delete(message.key);
    } else if (message.type === 'INVALIDATE_PATTERN' && message.pattern) {
      for (const key of l1.keys()) {
        if (matchPattern(key, message.pattern)) {
          l1.delete(key);
        }
      }
    } else if (message.type === 'FLUSH_ALL') {
      l1.clear();
    }
  } catch (err) {
    console.error(`[${instanceId}] Error processing pub/sub message:`, err);
  }
});

async function publishInvalidation(type, details = {}) {
  const message = {
    type,
    ...details,
    instanceId,
    timestamp: new Date().toISOString()
  };
  try {
    await redis.publish('cache-invalidation', JSON.stringify(message));
  } catch (err) {
    console.error(`[${instanceId}] Failed to publish invalidation:`, err);
  }
}

async function getOrSet(key, dbFetchFn) {
  stats.total_requests++;

  // 1. Check L1 cache
  if (l1.has(key)) {
    stats.l1_hits++;
    return {
      data: l1.get(key),
      cacheStatus: 'HIT-L1'
    };
  }
  stats.l1_misses++;

  // 2. Check L2 (Redis) cache
  try {
    const l2Data = await redis.get(key);
    if (l2Data !== null) {
      stats.l2_hits++;
      const parsed = JSON.parse(l2Data);
      l1.set(key, parsed);
      return {
        data: parsed,
        cacheStatus: 'HIT-L2'
      };
    }
  } catch (err) {
    console.error(`[${instanceId}] Redis error checking L2:`, err.message);
  }
  stats.l2_misses++;

  // 3. Query Database
  const dbData = await dbFetchFn();
  if (dbData !== null && dbData !== undefined) {
    stats.db_hits++;
    // Populate L1
    l1.set(key, dbData);
    // Populate L2
    try {
      await redis.set(key, JSON.stringify(dbData), 'EX', 300);
    } catch (err) {
      console.error(`[${instanceId}] Redis error populating L2:`, err.message);
    }
    return {
      data: dbData,
      cacheStatus: 'MISS'
    };
  }

  return null;
}

async function invalidateKey(key) {
  // Evict local L1
  l1.delete(key);

  // Evict Redis L2
  try {
    await redis.del(key);
  } catch (err) {
    console.error(`[${instanceId}] Redis error deleting key:`, err.message);
  }

  // Publish invalidation to all instances
  await publishInvalidation('INVALIDATE_KEY', { key });
}

async function invalidatePattern(pattern) {
  // Evict matching keys from local L1
  for (const key of l1.keys()) {
    if (matchPattern(key, pattern)) {
      l1.delete(key);
    }
  }

  // Evict matching keys from Redis L2
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (err) {
    console.error(`[${instanceId}] Redis error deleting pattern keys:`, err.message);
  }

  // Publish invalidation to all instances
  await publishInvalidation('INVALIDATE_PATTERN', { pattern });
}

async function clearAll() {
  // Clear local L1
  l1.clear();

  // Clear Redis
  try {
    await redis.flushdb();
  } catch (err) {
    console.error(`[${instanceId}] Redis flushdb error:`, err.message);
  }

  // Publish FLUSH_ALL
  await publishInvalidation('FLUSH_ALL');
}

function getStats() {
  const hitRatio = stats.total_requests > 0
    ? Number(((stats.l1_hits + stats.l2_hits) / stats.total_requests).toFixed(3))
    : 0;

  return {
    instanceId: stats.instanceId,
    l1_hits: stats.l1_hits,
    l1_misses: stats.l1_misses,
    l2_hits: stats.l2_hits,
    l2_misses: stats.l2_misses,
    db_hits: stats.db_hits,
    total_requests: stats.total_requests,
    hit_ratio: hitRatio
  };
}

module.exports = {
  redis,
  redisSub,
  getOrSet,
  invalidateKey,
  invalidatePattern,
  clearAll,
  getStats
};
