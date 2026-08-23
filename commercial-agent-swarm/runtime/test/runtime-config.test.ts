import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  loadBrokerRuntimeConfig,
  loadExecutorRuntimeConfig,
} from '../src/runtime-config.js'

const common = {
  EXECUTOR_SOCKET_PATH: '/run/commercial-swarm/executor.sock',
  HERMES_TIMEOUT_MS: '60000',
}
describe('split runtime trust-zone configuration', () => {
  it('broker rejects LLM key values and enforces client<lease with client>Hermes', () => {
    assert.throws(
      () =>
        loadBrokerRuntimeConfig({
          ...common,
          EXECUTOR_CLIENT_TIMEOUT_MS: '65000',
          DISPATCH_LEASE_SECONDS: '90',
          CUSTOM_API_KEY_FILE: '/secret',
        }),
      /BROKER_SECRET_BOUNDARY/,
    )
    assert.throws(
      () =>
        loadBrokerRuntimeConfig({
          ...common,
          EXECUTOR_CLIENT_TIMEOUT_MS: '65000',
          DISPATCH_LEASE_SECONDS: '60',
        }),
      /EXECUTOR_TIMEOUT_ORDER_INVALID/,
    )
    assert.equal(
      loadBrokerRuntimeConfig({
        ...common,
        EXECUTOR_CLIENT_TIMEOUT_MS: '65000',
        DISPATCH_LEASE_SECONDS: '90',
      }).childTimeoutSeconds,
      60,
    )
  })
  it('executor rejects database and host-service secrets and accepts only key-file configuration', () => {
    const good = {
      ...common,
      EXECUTOR_SOCKET_DIRECTORY: '/run/commercial-swarm',
      EXECUTOR_IPC_GID: '11000',
      HERMES_PROFILE_SEED: '/opt/profiles',
      HERMES_PROFILE_SEED_SHA256: 'a'.repeat(64),
      HERMES_TEMPORARY_ROOT: '/run/hermes-executor',
      CUSTOM_API_KEY_FILE: '/run/secrets/key',
      HTTP_PROXY: 'http://executor-egress-proxy:3128',
      HTTPS_PROXY: 'http://executor-egress-proxy:3128',
      NO_PROXY: 'broker,localhost,127.0.0.1',
      EXTERNAL_RESEARCH_ENABLED: 'false',
    }
    assert.equal(
      loadExecutorRuntimeConfig(good).customApiKeyFile,
      '/run/secrets/key',
    )
    assert.deepEqual(
      {
        uid: loadExecutorRuntimeConfig(good).executorUid,
        gid: loadExecutorRuntimeConfig(good).executorGid,
      },
      { uid: 10000, gid: 10000 },
    )
    assert.deepEqual(
      {
        uid: loadExecutorRuntimeConfig(good).childUid,
        gid: loadExecutorRuntimeConfig(good).childGid,
        ipcGid: loadExecutorRuntimeConfig(good).ipcGid,
      },
      { uid: 10002, gid: 10002, ipcGid: 11000 },
    )
    assert.throws(
      () => loadExecutorRuntimeConfig({ ...good, EXECUTOR_IPC_GID: '19000' }),
      /EXECUTOR_IPC_GID_INVALID/,
    )
    for (const name of [
      'DATABASE_URL',
      'DATABASE_URL_FILE',
      'WORK_ORDER_DATABASE_URL',
      'MAIL_TOKEN',
      'TELEGRAM_BOT_TOKEN',
      'DOCKER_HOST',
      'SSH_AUTH_SOCK',
      'HOSTINGER_TOKEN',
      'PGPASSWORD',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'WHATSAPP_TOKEN',
    ])
      assert.throws(
        () => loadExecutorRuntimeConfig({ ...good, [name]: 'secret' }),
        /EXECUTOR_SECRET_BOUNDARY/,
      )
    assert.throws(
      () =>
        loadExecutorRuntimeConfig({
          ...good,
          EXECUTOR_SOCKET_DIRECTORY: '/run',
        }),
      /UNSAFE_EXECUTOR_SOCKET_PATH/,
    )
    assert.throws(
      () =>
        loadExecutorRuntimeConfig({ ...good, HERMES_TEMPORARY_ROOT: '/tmp' }),
      /UNSAFE_HERMES_TEMPORARY_ROOT/,
    )
    for (const [name, value] of [
      ['HTTP_PROXY', 'http://attacker.invalid:3128'],
      ['HTTPS_PROXY', 'http://attacker.invalid:3128'],
      ['NO_PROXY', '*'],
    ] as const)
      assert.throws(
        () => loadExecutorRuntimeConfig({ ...good, [name]: value }),
        /EXECUTOR_MODEL_PROXY_INVALID/,
      )
  })
})
