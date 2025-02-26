import * as path from "path";
import * as fs from 'fs';
import { Stack, StackProps, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import * as glue from "aws-cdk-lib/aws-glue";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";


export class AthenaStack extends Stack {
  public readonly ATHENA_OUTPUT_BUCKET: s3.Bucket;
  public readonly ATHENA_DATA_BUCKET: s3.Bucket;
  public readonly ATHENA_DATABASE: glue.CfnDatabase;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Create S3 buckets for Athena
    this.ATHENA_DATA_BUCKET = new s3.Bucket(this, "AthenaDataBucket", {
      bucketName: `fraud-data-store-${this.account}-${this.region}`,
      enforceSSL: true,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsPrefix: "athena-data-bucket-logs/",
    });

    this.ATHENA_OUTPUT_BUCKET = new s3.Bucket(this, "AthenaOutputBucket", {
      bucketName: `fraud-athena-output-${this.account}-${this.region}`,
      enforceSSL: true,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsPrefix: "athena-output-bucket-logs/",
    });

    // Upload a sample csv file
    const dataDir = path.join(__dirname, "assets/data");
    const subDirs = fs.readdirSync(dataDir).filter((file) => fs.statSync(path.join(dataDir, file)).isDirectory());

    subDirs.forEach((subDir) => {
        new s3deploy.BucketDeployment(this, `Deploy${subDir.replace(/[^a-zA-Z0-9]/g, '')}SampleTable`, {
          sources: [s3deploy.Source.asset(path.join(dataDir, subDir))],
          destinationBucket: this.ATHENA_DATA_BUCKET,
          destinationKeyPrefix: `${subDir}`,
        });
    });


    // Create Athena Database
    this.ATHENA_DATABASE = new glue.CfnDatabase(this, "AthenaDatabase", {
      catalogId: this.account,
      databaseInput: {
        name: "fraud_data",
      },
    });

    // Create Glue Tables
    const tableConfig = JSON.parse(fs.readFileSync('lib/assets/tables.json', 'utf-8'));
    tableConfig.forEach((table: any) => {
      new glue.CfnTable(this, table.name, {
        catalogId: this.account,
        databaseName: this.ATHENA_DATABASE.ref!,
        tableInput: {
          name: table.name,
          tableType: "EXTERNAL_TABLE",
          parameters: {
            "skip.header.line.count": "1",
          },
          storageDescriptor: {
            location: `s3://${this.ATHENA_DATA_BUCKET.bucketName}/${table.name}`,
            inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
            outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
            serdeInfo: {
              serializationLibrary: "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe",
              parameters: {
                "field.delim": ",",
                "line.delim": "\n",
              }},
            columns: table.columns,
          },

        },
      });
    });

    // Outputs
    new CfnOutput(this, "AthenaDataBucketName", {
      value: this.ATHENA_DATA_BUCKET.bucketName,
      description: "Athena Data Bucket Name",
    });

    new CfnOutput(this, "AthenaOutputBucketName", {
      value: this.ATHENA_OUTPUT_BUCKET.bucketName,
      description: "Athena Output Bucket Name",
    });

    new CfnOutput(this, "AthenaDatabaseName", {
      value: this.ATHENA_DATABASE.ref,
      description: "Athena Database Name",
    });
  }
}
