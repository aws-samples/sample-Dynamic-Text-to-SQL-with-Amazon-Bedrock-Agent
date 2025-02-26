import * as cdk from 'aws-cdk-lib';
import * as path from "path";
import { Construct } from 'constructs';
import { readFileSync } from "fs";
import {
  PythonFunction,
  PythonLayerVersion,
} from "@aws-cdk/aws-lambda-python-alpha";
import {
  bedrock,
} from "@cdklabs/generative-ai-cdk-constructs";
import { AgentActionGroup } from "@cdklabs/generative-ai-cdk-constructs/lib/cdk-lib/bedrock";
import { Stack, StackProps, Duration } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Runtime, LayerVersion, Code } from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";

interface AgentsStackProps extends StackProps {
  ATHENA_OUTPUT_BUCKET: s3.Bucket;
  ATHENA_DATA_BUCKET: s3.Bucket;
}

export class AgentStack extends Stack {
  constructor(scope: Construct, id: string, props: AgentsStackProps) {
    super(scope, id, props);

    const lambdaPowertoolsLayer = new PythonLayerVersion(
        this,
        "LambdaPowertoolsLayer",
        {
          entry: path.join("src", "layers", "aws_lambda_powertools"),
          compatibleRuntimes: [Runtime.PYTHON_3_13],
          description: "Lambda Powertools for Python",
        },
    );

    const lambdaPydanticLayer = new PythonLayerVersion(
        this,
        "PydanticLayer",
        {
          entry: path.join("src", "layers", "pydantic"),
          compatibleRuntimes: [Runtime.PYTHON_3_13],
        }
    );

    // Common Layer for Athena utilities
    const athenaCommonLayer = new LayerVersion(this, "AthenaCommonLayer", {
      code: Code.fromAsset(
        path.join("src", "common"),
      ),
      description: "Common utilities for Athena operations",
      compatibleRuntimes: [Runtime.PYTHON_3_13],
    });

    // Define a function to create Athena Lambdas - 1. query execution, 2. schema read
    function createAthenaLambdaRole(
      parentScope: Construct,
      roleId: string,
      athenaDataBucket: s3.Bucket,
      athenaOutputBucket: s3.Bucket,
    ): iam.Role {
      const stack = Stack.of(parentScope);
      const role = new iam.Role(parentScope, roleId, {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      });

      // Sample tables list
      const glueTables = [
          'accounts', 'bank_branches', 'card_transactions', 'cards', 'customers',
          'devices', 'fraud_alerts', 'locations', 'merchants', 'rules_engine',
          'suspicious_patterns', 'transaction_history', 'transactions'
      ];

      role.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents",
          ],
          resources: [
            `arn:aws:logs:${stack.region}:${stack.account}:log-group:*`
          ],
        }),
      );

      role.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "athena:StartQueryExecution",
            "athena:GetQueryExecution",
            "athena:GetQueryResults",
          ],
          resources: [
            `arn:aws:athena:${stack.region}:${stack.account}:workgroup/primary`,
          ],
        }),
      );

      role.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "glue:GetDatabase",
            "glue:GetTable",
            "glue:GetTables",
            "glue:GetPartitions",
          ],
          resources: [
            `arn:aws:glue:${stack.region}:${stack.account}:catalog`,
            `arn:aws:glue:${stack.region}:${stack.account}:database/default`,
            `arn:aws:glue:${stack.region}:${stack.account}:database/fraud_data`,
            `arn:aws:glue:${stack.region}:${stack.account}:table/default/fraud_data`,
            ...glueTables.map(table =>
              `arn:aws:glue:${stack.region}:${stack.account}:table/fraud_data/${table}`
            )
          ],
        }),
      );

      role.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "s3:GetBucketLocation",
            "s3:GetObject",
            "s3:ListBucket",
            "s3:PutObject",
          ],
          resources: [
            athenaDataBucket.bucketArn,
            ...glueTables.map(table => `${athenaDataBucket.bucketArn}/${table}/${table}.csv`),
            athenaOutputBucket.bucketArn,
            `${athenaOutputBucket.bucketArn}/query-results/*`,
          ],
        }),
      );

      return role;
    }

    // Define a function to create Agent action group Lambdas
    function createLambdaFunction(
      parentScope: Construct,
      lambdaId: string,
      lambdaProps: {
        entry: string;
        role?: iam.Role;
        layers?: PythonLayerVersion[];
        environment?: { [key: string]: string };
        deadLetterQueue?: sqs.Queue;
      },
    ): PythonFunction {
      // Extract the file name, which is set to be same as the directory base name
      const fileName = path.basename(lambdaProps.entry);
      return new PythonFunction(parentScope, lambdaId, {
        functionName: `${path.parse(fileName).name}-${id}`,
        entry: lambdaProps.entry,
        index: fileName + ".py",
        handler: "lambda_handler",
        runtime: Runtime.PYTHON_3_13,
        timeout: Duration.minutes(5),
        memorySize: 256,
        environment: lambdaProps.environment,
        layers: lambdaProps.layers,
        role: lambdaProps.role,
        deadLetterQueue: lambdaProps.deadLetterQueue,
      });
    }

    // Export agent instruction for Agent
    const instruction = readFileSync(
      path.join(__dirname, "../prompt", "instruction.txt"),
      "utf8",
    );

    // Change this to your desired region:
    // US (default) - bedrock.CrossRegionInferenceProfileRegion.US
    // EU - bedrock.CrossRegionInferenceProfileRegion.EU,
    // APAC - bedrock.CrossRegionInferenceProfileRegion.APAC
    const anthropicClaudeRegionInferenceProfile = bedrock.CrossRegionInferenceProfile.fromConfig({
      geoRegion: bedrock.CrossRegionInferenceProfileRegion.US,
      model: bedrock.BedrockFoundationModel.ANTHROPIC_CLAUDE_3_5_SONNET_V2_0
    })

    // Create Dynamic Bedrock Agent with Dynamic Schema Discovery
    const dynamicAgent = new bedrock.Agent(this, "DynamicAgent", {
      name: cdk.Stack.of(this) + "-" + "DynamicAgent",
      foundationModel: anthropicClaudeRegionInferenceProfile,
      shouldPrepareAgent: true,
      userInputEnabled: true,
      codeInterpreterEnabled: true,
      instruction:
        "You are " +
        this.node.tryGetContext("custom:agentName") +
        ", a SQL analyst AI created specifically for " +
        this.node.tryGetContext("custom:companyName") +
        ". If Human says Hello, Greet the human with your name. " +
        "\n" +
        instruction,
    });

    // Create IAM role for Athena Schema Reader Lambda
    const athenaSchemaReaderRole = createAthenaLambdaRole(
      this,
      "AthenaSchemaReaderRole",
      props.ATHENA_DATA_BUCKET,
      props.ATHENA_OUTPUT_BUCKET,
    );

    // Create Athena Schema Reader Lambda
    const athenaSchemaReaderLambda = createLambdaFunction(
      this,
      "AthenaSchemaReaderLambda",
      {
        entry: path.join(
          "src",
          "athena_schema_reader",
        ),
        role: athenaSchemaReaderRole,
        layers: [
          lambdaPowertoolsLayer,
          lambdaPydanticLayer,
          athenaCommonLayer,
        ],
        environment: {
          S3_OUTPUT: props.ATHENA_OUTPUT_BUCKET.bucketName,
          S3_DATA_BUCKET: props.ATHENA_DATA_BUCKET.bucketName,
        },
      },
    );

    // Create DLQ for Athena Query Lambda
    const athenaQueryLambdaDLQ = new sqs.Queue(this, "AthenaQueryLambdaDLQ", {
      queueName: `AthenaQueryLambdaDLQs-Fraud-${this.account}-${this.region}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    // Create IAM role for Athena Query Execution Lambda
    const athenaQueryLambdaRole = createAthenaLambdaRole(
      this,
      "AthenaQueryLambdaRole",
      props.ATHENA_DATA_BUCKET,
      props.ATHENA_OUTPUT_BUCKET,
    );
    athenaQueryLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [athenaQueryLambdaDLQ.queueArn],
      }),
    );

    // Create Athena Query Execution Lambda
    const athenaQueryLambda = createLambdaFunction(this, "AthenaQueryLambda", {
      entry: path.join(
        "src",
        "athena_query",
      ),
      role: athenaQueryLambdaRole,
      layers: [
        lambdaPowertoolsLayer,
        lambdaPydanticLayer,
        athenaCommonLayer,
      ],
      environment: {
        S3_OUTPUT: props.ATHENA_OUTPUT_BUCKET.bucketName,
        S3_DATA_BUCKET: props.ATHENA_DATA_BUCKET.bucketName,
      },
      deadLetterQueue: athenaQueryLambdaDLQ,
    });

    // Grant permissions to the Lambda function
    props.ATHENA_DATA_BUCKET.grantReadWrite(
      athenaQueryLambda,
      athenaSchemaReaderLambda,
    );
    props.ATHENA_OUTPUT_BUCKET.grantReadWrite(
      athenaQueryLambda,
      athenaSchemaReaderLambda,
    );


    // Add Athena Query Action Group
    const athenaQueryActionGroup = new bedrock.AgentActionGroup({
      name: "AthenaQueryActionGroup",
      description: "This action group is used to query information about data",
      executor: bedrock.ActionGroupExecutor.fromlambdaFunction(athenaQueryLambda),
      apiSchema: bedrock.ApiSchema.fromLocalAsset(
        path.join(__dirname, "../src/athena_query", "openapi.json")
      )
    })
    dynamicAgent.addActionGroup(athenaQueryActionGroup)

    // Add Athena Schema Reader Action Group
    const athenaSchemaReaderActionGroup = new bedrock.AgentActionGroup({
      name: "AthenaSchemaReaderActionGroup",
      description: "This action group is used to read schema from Athena",
      executor: bedrock.ActionGroupExecutor.fromlambdaFunction(athenaSchemaReaderLambda),
      apiSchema: bedrock.ApiSchema.fromLocalAsset(
        path.join(__dirname, "../src/athena_schema_reader", "openapi.json")
      )
    })
    dynamicAgent.addActionGroup(athenaSchemaReaderActionGroup);
  }
}
