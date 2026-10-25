import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate, loadContract } from '../../dist/index.js';

/** Include optional credential runtime classes in the implementation analysis. */
export function generateAnalysisPackage(root) {
  const api = JSON.parse(readFileSync('examples/library.openapi.json', 'utf8'));
  api.components ??= {};
  api.components.securitySchemes = { Bearer: { type: 'http', scheme: 'bearer' } };
  api.security = [{ Bearer: [] }];
  const config = JSON.parse(readFileSync('examples/library.sdk.json', 'utf8'));
  config.auth = {
    modes: { service: { schemes: ['Bearer'] } },
    defaultCredentials: {
      mode: 'service',
      scheme: 'Bearer',
      environment: { apiKey: 'EXAMPLE_API_KEY', token: 'EXAMPLE_ACCESS_TOKEN' },
      workloadIdentity: {
        tokenPath: '/oauth/token',
        credentialParameter: 'workload_identity_id',
        envPrefix: 'EXAMPLE',
      },
    },
  };
  writeFileSync(join(root, 'api.json'), JSON.stringify(api));
  writeFileSync(join(root, 'sdk.json'), JSON.stringify(config));
  const output = join(root, 'sdk');
  generate(loadContract(join(root, 'api.json'), join(root, 'sdk.json')), output);
  return output;
}
