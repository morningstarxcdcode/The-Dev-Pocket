// Mock Prisma globally for tests in this file to avoid real DB connections
jest.mock('@prisma/client', () => {
  class MockPrisma {
    newsletterSubscriber = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: '123', email: 'test@example.com' }),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(10),
      findMany: jest.fn().mockResolvedValue([]),
    };
  }
  return { PrismaClient: MockPrisma };
});

describe('Newsletter API - Rate Limiting and Headers', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/testdb';
  });

  afterEach(async () => {
    jest.resetModules();
    delete process.env.CSRF_PROTECTION;
    delete process.env.CSRF_PROTECTION_TOKEN;
    // Reset in-memory rate limiter state so tests are isolated
    const { __testResetRateLimit } = await import('@/lib/rate-limit');
    __testResetRateLimit();
  });

  describe('POST /api/newsletter', () => {
    it('returns X-RateLimit headers on successful request', async () => {
      const { POST } = await import('@/app/api/newsletter/route');

      const req = new Request('https://example.com/api/newsletter', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1'
        },
        body: JSON.stringify({ email: 'test@example.com', name: 'Test User' }),
      });

      const res = await POST(req as any);
      expect(res.status).toBe(201);
      
      // Check rate limit headers
      expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('2');
      expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
    });

    it('enforces rate limit of 3 requests per hour per IP', async () => {
      jest.resetModules();
      
      // Mock Prisma
      jest.doMock('@prisma/client', () => {
        class MockPrisma {
          newsletterSubscriber = {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: '123', email: 'test@example.com' }),
          };
        }
        return { PrismaClient: MockPrisma };
      });

      const { POST } = await import('@/app/api/newsletter/route');
      const { __testResetRateLimit } = await import('@/lib/rate-limit');
      __testResetRateLimit();

      const makeRequest = async (email: string) => {
        return await POST(new Request('https://example.com/api/newsletter', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-forwarded-for': '192.168.1.100'
          },
          body: JSON.stringify({ email }),
        }) as any);
      };

      // First request - should succeed
      const res1 = await makeRequest('test1@example.com');
      expect(res1.status).toBe(201);
      expect(res1.headers.get('X-RateLimit-Remaining')).toBe('2');

      // Second request - should succeed
      const res2 = await makeRequest('test2@example.com');
      expect(res2.status).toBe(201);
      expect(res2.headers.get('X-RateLimit-Remaining')).toBe('1');

      // Third request - should succeed
      const res3 = await makeRequest('test3@example.com');
      expect(res3.status).toBe(201);
      expect(res3.headers.get('X-RateLimit-Remaining')).toBe('0');

      // Fourth request - should be rate limited
      const res4 = await makeRequest('test4@example.com');
      expect(res4.status).toBe(429);
      expect(res4.headers.get('X-RateLimit-Remaining')).toBe('0');
      
      const body = await res4.json();
      expect(body.error).toMatch(/rate limit/i);
    });

    it('returns rate limit headers on validation errors', async () => {
      const { POST } = await import('@/app/api/newsletter/route');

      const req = new Request('https://example.com/api/newsletter', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.2'
        },
        body: JSON.stringify({ email: 'invalid-email' }),
      });

      const res = await POST(req as any);
      expect(res.status).toBe(400);
      
      // Should still have rate limit headers
      expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
      expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
      expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
    });

    it('returns rate limit headers on duplicate email errors', async () => {
      jest.resetModules();
      
      // Mock Prisma to return existing subscriber
      jest.doMock('@prisma/client', () => {
        class MockPrisma {
          newsletterSubscriber = {
            findUnique: jest.fn().mockResolvedValue({ 
              id: '1', 
              email: 'existing@example.com',
              status: 'active' 
            }),
          };
        }
        return { PrismaClient: MockPrisma };
      });

      const { POST } = await import('@/app/api/newsletter/route');

      const req = new Request('https://example.com/api/newsletter', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.3'
        },
        body: JSON.stringify({ email: 'existing@example.com' }),
      });

      const res = await POST(req as any);
      expect(res.status).toBe(409);
      
      // Should still have rate limit headers
      expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
      expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
      expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
    });
  });

  describe('DELETE /api/newsletter', () => {
    it('returns X-RateLimit headers on successful request', async () => {
      jest.resetModules();
      
      // Mock Prisma
      jest.doMock('@prisma/client', () => {
        class MockPrisma {
          newsletterSubscriber = {
            findUnique: jest.fn().mockResolvedValue({ 
              id: '1', 
              email: 'test@example.com',
              status: 'active' 
            }),
            update: jest.fn().mockResolvedValue({}),
          };
        }
        return { PrismaClient: MockPrisma };
      });

      const { DELETE } = await import('@/app/api/newsletter/route');

      const url = new URL('https://example.com/api/newsletter');
      url.searchParams.set('email', 'test@example.com');

      const req = new Request(url.toString(), {
        method: 'DELETE',
        headers: { 'x-forwarded-for': '192.168.1.4' }
      });

      const res = await DELETE(req as any);
      expect(res.status).toBe(200);
      
      // Check rate limit headers
      expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('2');
      expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
    });

    it('enforces rate limit on DELETE requests', async () => {
      jest.resetModules();
      
      // Mock Prisma
      jest.doMock('@prisma/client', () => {
        class MockPrisma {
          newsletterSubscriber = {
            findUnique: jest.fn().mockResolvedValue({ 
              id: '1', 
              email: 'test@example.com',
              status: 'active' 
            }),
            update: jest.fn().mockResolvedValue({}),
          };
        }
        return { PrismaClient: MockPrisma };
      });

      const { DELETE } = await import('@/app/api/newsletter/route');
      const { __testResetRateLimit } = await import('@/lib/rate-limit');
      __testResetRateLimit();

      const makeRequest = async () => {
        const url = new URL('https://example.com/api/newsletter');
        url.searchParams.set('email', 'test@example.com');
        
        return await DELETE(new Request(url.toString(), {
          method: 'DELETE',
          headers: { 'x-forwarded-for': '192.168.1.200' }
        }) as any);
      };

      // First 3 requests should succeed
      await makeRequest();
      await makeRequest();
      await makeRequest();

      // Fourth request should be rate limited
      const res4 = await makeRequest();
      expect(res4.status).toBe(429);
      expect(res4.headers.get('X-RateLimit-Remaining')).toBe('0');
    });

    it('returns rate limit headers on validation errors', async () => {
      const { DELETE } = await import('@/app/api/newsletter/route');

      const url = new URL('https://example.com/api/newsletter');
      // Missing email parameter

      const req = new Request(url.toString(), {
        method: 'DELETE',
        headers: { 'x-forwarded-for': '192.168.1.5' }
      });

      const res = await DELETE(req as any);
      expect(res.status).toBe(400);
      
      // Should still have rate limit headers
      expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
      expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
      expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
    });
  });

  describe('GET /api/newsletter/stats', () => {
    it('returns X-RateLimit headers on successful request', async () => {
      jest.resetModules();
      
      // Mock Prisma
      jest.doMock('@prisma/client', () => {
        class MockPrisma {
          newsletterSubscriber = {
            count: jest.fn().mockResolvedValue(10),
            findMany: jest.fn().mockResolvedValue([]),
          };
        }
        return { PrismaClient: MockPrisma };
      });

      const { GET } = await import('@/app/api/newsletter/route');

      const req = new Request('https://example.com/api/newsletter', {
        method: 'GET',
        headers: { 'x-forwarded-for': '192.168.1.6' }
      });

      const res = await GET(req as any);
      expect(res.status).toBe(200);
      
      // Check rate limit headers
      expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('2');
      expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
    });

    it('enforces rate limit on GET requests', async () => {
      jest.resetModules();
      
      // Mock Prisma
      jest.doMock('@prisma/client', () => {
        class MockPrisma {
          newsletterSubscriber = {
            count: jest.fn().mockResolvedValue(10),
            findMany: jest.fn().mockResolvedValue([]),
          };
        }
        return { PrismaClient: MockPrisma };
      });

      const { GET } = await import('@/app/api/newsletter/route');
      const { __testResetRateLimit } = await import('@/lib/rate-limit');
      __testResetRateLimit();

      const makeRequest = async () => {
        return await GET(new Request('https://example.com/api/newsletter', {
          method: 'GET',
          headers: { 'x-forwarded-for': '192.168.1.300' }
        }) as any);
      };

      // First 3 requests should succeed
      await makeRequest();
      await makeRequest();
      await makeRequest();

      // Fourth request should be rate limited
      const res4 = await makeRequest();
      expect(res4.status).toBe(429);
      expect(res4.headers.get('X-RateLimit-Remaining')).toBe('0');
    });
  });

  describe('Rate limiting across different IPs', () => {
    it('tracks rate limits separately per IP address', async () => {
      jest.resetModules();
      
      // Mock Prisma
      jest.doMock('@prisma/client', () => {
        class MockPrisma {
          newsletterSubscriber = {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: '123', email: 'test@example.com' }),
          };
        }
        return { PrismaClient: MockPrisma };
      });

      const { POST } = await import('@/app/api/newsletter/route');
      const { __testResetRateLimit } = await import('@/lib/rate-limit');
      __testResetRateLimit();

      // Make 3 requests from IP1
      for (let i = 0; i < 3; i++) {
        const res = await POST(new Request('https://example.com/api/newsletter', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-forwarded-for': '10.0.0.1'
          },
          body: JSON.stringify({ email: `test${i}@example.com` }),
        }) as any);
        expect(res.status).toBe(201);
      }

      // Fourth request from IP1 should be rate limited
      const res1 = await POST(new Request('https://example.com/api/newsletter', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.1'
        },
        body: JSON.stringify({ email: 'test4@example.com' }),
      }) as any);
      expect(res1.status).toBe(429);

      // But request from IP2 should still succeed
      const res2 = await POST(new Request('https://example.com/api/newsletter', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-forwarded-for': '10.0.0.2'
        },
        body: JSON.stringify({ email: 'another@example.com' }),
      }) as any);
      expect(res2.status).toBe(201);
      expect(res2.headers.get('X-RateLimit-Remaining')).toBe('2');
    });
  });
});
