import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  migrationDigest,
  validateMigrationSet,
} from '../src/migration-runner.js'
import { loadMigrationSources } from '../src/migrate-main.js'

describe('versioned migration runner', () => {
  it('orders a closed migration set and calculates stable SHA-256 digests', () => {
    const migrations = validateMigrationSet([
      { version: '004_crm_integration', sql: 'SELECT 4;' },
      { version: '005_portfolio_read_models', sql: 'SELECT 5;' },
      { version: '006_sales_read_models', sql: 'SELECT 6;' },
      { version: '007_usage_budget_ledger', sql: 'SELECT 7;' },
      { version: '008_simulation_safety_seed', sql: 'SELECT 8;' },
      { version: '009_internal_automation', sql: 'SELECT 9;' },
      { version: '010_instruction_inbox', sql: 'SELECT 10;' },
      { version: '011_go_native_usage_ledger', sql: 'SELECT 11;' },
      { version: '012_dependency_terminalization', sql: 'SELECT 12;' },
      { version: '013_variable_usage_reservations', sql: 'SELECT 13;' },
      { version: '014_variable_usage_constraint', sql: 'SELECT 14;' },
      { version: '015_shadow_human_review', sql: 'SELECT 15;' },
      { version: '016_usage_source_not_null', sql: 'SELECT 16;' },
      { version: '017_external_action_kill_switch_projection', sql: 'SELECT 17;' },
      { version: '018_sales_mission_draft_projection', sql: 'SELECT 18;' },
      { version: '019_codex_instruction_review', sql: 'SELECT 19;' },
      { version: '020_internal_mail_attestation', sql: 'SELECT 20;' },
      { version: '021_commercial_policy_v2_draft', sql: 'SELECT 21;' },
      { version: '022_policy_human_review', sql: 'SELECT 22;' },
      { version: '023_policy_activation_dossier', sql: 'SELECT 23;' },
      { version: '024_draft_internal_review', sql: 'SELECT 24;' },
      { version: '025_a1_research_dossier', sql: 'SELECT 25;' },
      { version: '026_a1_research_authorization', sql: 'SELECT 26;' },
      { version: '027_a1_research_order_authorization', sql: 'SELECT 27;' },
      { version: '028_ed25519_a1_work_orders', sql: 'SELECT 28;' },
      { version: '029_a1_authorization_renewal', sql: 'SELECT 29;' },
      { version: '030_a1_dispatch_authorization', sql: 'SELECT 30;' },
      { version: '031_a1_assignment_enqueue_authorization', sql: 'SELECT 31;' },
      { version: '032_a1_assignment_execution_authorization', sql: 'SELECT 32;' },
      { version: '033_a1_dispatch_execution_arm', sql: 'SELECT 33;' },
      { version: '034_a1_dispatch_execution_window', sql: 'SELECT 34;' },
      { version: '003_dispatch_queue', sql: 'SELECT 3;' },
      { version: '001_runtime', sql: 'SELECT 1;' },
      { version: '002_commercial_control_plane', sql: 'SELECT 2;' },
    ])
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [
        '001_runtime',
        '002_commercial_control_plane',
        '003_dispatch_queue',
        '004_crm_integration',
        '005_portfolio_read_models',
        '006_sales_read_models',
        '007_usage_budget_ledger',
        '008_simulation_safety_seed',
        '009_internal_automation',
        '010_instruction_inbox',
        '011_go_native_usage_ledger',
        '012_dependency_terminalization',
        '013_variable_usage_reservations',
        '014_variable_usage_constraint',
        '015_shadow_human_review',
        '016_usage_source_not_null',
        '017_external_action_kill_switch_projection',
        '018_sales_mission_draft_projection',
        '019_codex_instruction_review',
        '020_internal_mail_attestation',
        '021_commercial_policy_v2_draft',
        '022_policy_human_review',
        '023_policy_activation_dossier',
        '024_draft_internal_review',
        '025_a1_research_dossier',
        '026_a1_research_authorization',
        '027_a1_research_order_authorization',
        '028_ed25519_a1_work_orders',
        '029_a1_authorization_renewal',
        '030_a1_dispatch_authorization',
        '031_a1_assignment_enqueue_authorization',
        '032_a1_assignment_execution_authorization',
        '033_a1_dispatch_execution_arm',
        '034_a1_dispatch_execution_window',
      ],
    )
    assert.equal(
      migrationDigest('SELECT 1;'),
      '17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a',
    )
  })

  it('loads the complete production migration set through the exact A1 execution-window gate', async () => {
    const migrations = await loadMigrationSources()
    assert.equal(migrations.length, 34)
    assert.equal(migrations.at(-1)?.version, '034_a1_dispatch_execution_window')
    assert.match(
      migrations.at(-7)?.sql ?? '',
      /A1_ED25519_SIGNATURE_REQUIRED/,
    )
    assert.match(migrations.at(-1)?.sql ?? '', /A1_DISPATCH_EXECUTION_WINDOW_GATE_CLOSED/)
    assert.doesNotMatch(
      migrations.at(-1)?.sql ?? '',
      /control\.enqueue_dispatch|mail\.send|integration\.enqueue_crm_change/i,
    )
  })

  it('rejects missing, duplicate, extra, or malformed migration history', () => {
    for (const migrations of [
      [],
      [
        { version: '001_runtime', sql: 'SELECT 1;' },
        { version: '001_runtime', sql: 'SELECT 1;' },
      ],
      [
        { version: '001_runtime', sql: 'SELECT 1;' },
        { version: '002_commercial_control_plane', sql: '' },
        { version: '003_dispatch_queue', sql: 'SELECT 3;' },
        { version: '004_crm_integration', sql: 'SELECT 4;' },
        { version: '005_portfolio_read_models', sql: 'SELECT 5;' },
        { version: '006_sales_read_models', sql: 'SELECT 6;' },
        { version: '007_usage_budget_ledger', sql: 'SELECT 7;' },
        { version: '008_simulation_safety_seed', sql: 'SELECT 8;' },
        { version: '009_internal_automation', sql: 'SELECT 9;' },
        { version: '010_instruction_inbox', sql: 'SELECT 10;' },
        { version: '011_go_native_usage_ledger', sql: 'SELECT 11;' },
      ],
      [
        { version: '001_runtime', sql: 'SELECT 1;' },
        { version: '002_commercial_control_plane', sql: 'SELECT 2;' },
        { version: '003_dispatch_queue', sql: 'SELECT 3;' },
        { version: '004_crm_integration', sql: 'SELECT 4;' },
        { version: '005_portfolio_read_models', sql: 'SELECT 5;' },
        { version: '006_sales_read_models', sql: 'SELECT 6;' },
        { version: '007_usage_budget_ledger', sql: 'SELECT 7;' },
        { version: '008_simulation_safety_seed', sql: 'SELECT 8;' },
        { version: '009_internal_automation', sql: 'SELECT 9;' },
        { version: '010_instruction_inbox', sql: 'SELECT 10;' },
        { version: '011_go_native_usage_ledger', sql: 'SELECT 11;' },
        { version: '005_unapproved', sql: 'SELECT 5;' },
      ],
    ])
      assert.throws(
        () => validateMigrationSet(migrations),
        /INVALID_MIGRATION_SET/,
      )
  })
})
