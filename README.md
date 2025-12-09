# KB Labs Adapters

> **Adapter implementations for KB Labs ecosystem** — OpenAI, Redis, Qdrant, Pino, Analytics, and File System adapters implementing standard KB Labs interfaces.

[![License](https://img.shields.io/badge/License-KB%20Public%20v1.1-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18.18.0+-green.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9.0.0+-orange.svg)](https://pnpm.io/)

## 🎯 Overview

KB Labs Adapters is a collection of adapter implementations that integrate external services and systems with the KB Labs platform. Each adapter implements standard KB Labs interfaces, providing a consistent API across different backends.

### Available Adapters

| Package | Description | Implements |
|---------|-------------|------------|
| **@kb-labs/adapters-openai** | OpenAI integration | `ILLM`, `IEmbeddings` |
| **@kb-labs/adapters-redis** | Redis client | `ICacheAdapter` |
| **@kb-labs/adapters-qdrant** | Qdrant vector database | `IVectorStore` |
| **@kb-labs/adapters-pino** | Pino logger | `ILogger` |
| **@kb-labs/adapters-analytics-file** | File-based analytics | `IAnalytics` |
| **@kb-labs/adapters-fs** | File system operations | `IFileSystem` |

## 🚀 Quick Start

### Installation

```bash
# Install specific adapter
pnpm add @kb-labs/adapters-openai
pnpm add @kb-labs/adapters-redis
pnpm add @kb-labs/adapters-qdrant

# Or install from monorepo
cd kb-labs-adapters
pnpm install
```

### Usage Examples

#### OpenAI Adapter

```typescript
import { OpenAILLM, OpenAIEmbeddings } from '@kb-labs/adapters-openai';

// LLM adapter
const llm = new OpenAILLM({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4-turbo',
});

const response = await llm.generate({
  prompt: 'Explain TypeScript generics',
  temperature: 0.7,
});

// Embeddings adapter
const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'text-embedding-3-small',
});

const vectors = await embeddings.embed(['hello world', 'foo bar']);
```

#### Redis Adapter

```typescript
import { RedisAdapter } from '@kb-labs/adapters-redis';

const redis = new RedisAdapter({
  host: 'localhost',
  port: 6379,
});

await redis.set('key', 'value', { ttl: 3600 });
const value = await redis.get('key');
```

#### Qdrant Adapter

```typescript
import { QdrantVectorStore } from '@kb-labs/adapters-qdrant';

const vectorStore = new QdrantVectorStore({
  url: 'http://localhost:6333',
  collection: 'my-collection',
});

await vectorStore.upsert([
  { id: '1', vector: [0.1, 0.2, 0.3], metadata: { text: 'example' } },
]);

const results = await vectorStore.search([0.1, 0.2, 0.3], { limit: 10 });
```

#### Pino Logger

```typescript
import { PinoLogger } from '@kb-labs/adapters-pino';

const logger = new PinoLogger({
  level: 'info',
  pretty: process.env.NODE_ENV === 'development',
});

logger.info({ userId: '123' }, 'User logged in');
logger.error({ err }, 'Failed to process request');
```

## 📦 Packages

### [@kb-labs/adapters-openai](./packages/adapters-openai/)

OpenAI API integration providing:
- **LLM adapter** - Text generation with GPT models
- **Embeddings adapter** - Vector embeddings with text-embedding models
- Streaming support
- Token counting
- Error handling

### [@kb-labs/adapters-redis](./packages/adapters-redis/)

Redis client adapter providing:
- Key-value storage
- TTL support
- Pipeline operations
- Pub/sub messaging
- Connection pooling

### [@kb-labs/adapters-qdrant](./packages/adapters-qdrant/)

Qdrant vector database adapter providing:
- Vector storage and search
- Metadata filtering
- Hybrid search (vector + keyword)
- Collection management
- Batch operations

### [@kb-labs/adapters-pino](./packages/adapters-pino/)

Pino logger adapter providing:
- Structured logging
- Log levels (trace, debug, info, warn, error, fatal)
- Child loggers
- Pretty printing (development)
- JSON output (production)

### [@kb-labs/adapters-analytics-file](./packages/adapters-analytics-file/)

File-based analytics adapter providing:
- Event tracking
- File-based storage
- JSON format
- Rotation support

### [@kb-labs/adapters-fs](./packages/adapters-fs/)

File system adapter providing:
- Read/write operations
- Directory operations
- Path utilities
- Async/promise-based API

## 🏗️ Architecture

All adapters follow the **Adapter Pattern**, implementing standard KB Labs interfaces:

```
┌─────────────────┐
│  KB Labs Core   │
│   Interfaces    │  (ILLM, ILogger, IVectorStore, etc.)
└────────┬────────┘
         │
         │ implements
         │
┌────────┴────────┐
│    Adapters     │
├─────────────────┤
│  • OpenAI       │ → OpenAI API
│  • Redis        │ → Redis Server
│  • Qdrant       │ → Qdrant API
│  • Pino         │ → Console/Files
│  • Analytics    │ → Files
│  • FS           │ → File System
└─────────────────┘
```

### Benefits

- **Swappable implementations** - Change backends without changing code
- **Testability** - Mock adapters for testing
- **Consistency** - Same API across different services
- **Type safety** - TypeScript interfaces enforce contracts

## 🔧 Development

### Prerequisites

- **Node.js** >= 18.18.0
- **pnpm** >= 9.0.0

### Setup

```bash
# Clone repository
git clone https://github.com/kirill-baranov/kb-labs-adapters.git
cd kb-labs-adapters

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Development Workflow

```bash
# Watch mode (auto-rebuild on changes)
pnpm dev

# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Lint code
pnpm lint

# Type check
pnpm type-check

# Format code
pnpm format
```

### Creating a New Adapter

1. Create package directory: `packages/adapters-<name>/`
2. Implement KB Labs interface (e.g., `ILLM`, `ILogger`)
3. Add tests
4. Export from `index.ts`
5. Update this README

Example structure:

```
packages/adapters-example/
├── src/
│   ├── index.ts       # Main export
│   ├── adapter.ts     # Adapter implementation
│   └── types.ts       # Types and interfaces
├── test/
│   └── adapter.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

## 📚 Documentation

- [Architecture Decisions](./docs/adr/) - ADRs for this repository
- [Contributing Guide](./CONTRIBUTING.md) - How to contribute
- Individual package READMEs in `packages/*/README.md`

## 🤝 Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines and contribution process.

## 🔗 Related Projects

### Core Platform
- [@kb-labs/core](https://github.com/KirillBaranov/kb-labs-core) - Core runtime and utilities
- [@kb-labs/cli](https://github.com/KirillBaranov/kb-labs-cli) - CLI interface
- [@kb-labs/plugin](https://github.com/KirillBaranov/kb-labs-plugin) - Plugin system

### Integration
- [@kb-labs/mind](https://github.com/KirillBaranov/kb-labs-mind) - AI-powered code search (uses OpenAI, Qdrant adapters)
- [@kb-labs/workflow](https://github.com/KirillBaranov/kb-labs-workflow) - Workflow engine (uses Redis adapter)
- [@kb-labs/analytics](https://github.com/KirillBaranov/kb-labs-analytics) - Analytics (uses analytics-file adapter)

## License

KB Public License v1.1 - see [LICENSE](LICENSE) for details.

This is open source software with some restrictions on:
- Offering as a hosted service (SaaS/PaaS)
- Creating competing platform products

For commercial licensing inquiries: contact@kblabs.dev

**User Guides:**
- [English Guide](../LICENSE-GUIDE.en.md)
- [Русское руководство](../LICENSE-GUIDE.ru.md)
