import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AgentStack } from '../lib/agent-stack';
import { AthenaStack } from '../lib/db-stack';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib';

const app = new cdk.App();
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))

// Setting Common Environment
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION
};

// * Setting stack name prefix
const stackNamePrefix = "AwsText2Sql-";

// * Create AthenaStack
const athenaStack = new AthenaStack(app, stackNamePrefix + 'DbStack', {
  env: env,
});

const agentStack = new AgentStack(app, stackNamePrefix + 'AgentStack', {
  env: env,
  ATHENA_OUTPUT_BUCKET: athenaStack.ATHENA_OUTPUT_BUCKET,
  ATHENA_DATA_BUCKET: athenaStack.ATHENA_DATA_BUCKET,
});
agentStack.addDependency(athenaStack);

NagSuppressions.addStackSuppressions(agentStack, [
  {
    id: 'AwsSolutions-IAM5',
    reason: 'Required wildcards are scoped to specific resources and service integrations',
  },
]);

NagSuppressions.addStackSuppressions(athenaStack, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'CDK generated custom Lambda function',
  },
  {
    id: 'AwsSolutions-IAM5',
    reason: 'CDK generated custom Lambda function',
  },
  {
    id: 'AwsSolutions-L1',
    reason: 'CDK generated custom Lambda function',
  },
]);
