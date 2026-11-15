import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';

export { grpc };
export const protoPath = fileURLToPath(new URL('../proto/nix_ci_build/v1/reporting.proto', import.meta.url));

export function loadProtocol(path = protoPath) {
  const definition = protoLoader.loadSync(path, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: false,
    oneofs: true,
  });
  const protocol = grpc.loadPackageDefinition(definition).nix_ci_build.v1;
  return {
    ReportingClient: protocol.Reporting,
    ReportingService: protocol.Reporting.service,
  };
}

export const { ReportingClient, ReportingService } = loadProtocol();
