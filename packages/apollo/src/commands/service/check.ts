import { flags } from "@oclif/command";
import { table } from "heroku-cli-util";
import { introspectionFromSchema } from "graphql";
import chalk from "chalk";
import { gitInfo, GitContext } from "../../git";
import { ProjectCommand } from "../../Command";
import { validateHistoricParams } from "../../utils";
import {
  CheckSchema_service_checkSchema,
  CheckSchema_service_checkSchema_diffToPrevious_changes as Change,
  ChangeType
} from "apollo-language-server/lib/graphqlTypes";
import { ApolloConfig } from "apollo-language-server";
import moment from "moment";

const formatChange = (change: Change) => {
  let color = (x: string): string => x;
  if (change.type === ChangeType.FAILURE) {
    color = chalk.red;
  }
  if (change.type === ChangeType.WARNING) {
    color = chalk.yellow;
  }

  return {
    type: color(change.type),
    code: color(change.code),
    description: color(change.description)
  };
};

interface TasksOutput {
  gitContext?: GitContext;
  checkSchemaResult: CheckSchema_service_checkSchema;
  config: ApolloConfig;
  shouldOutputJson: boolean;
  shouldOutputMarkdown: boolean;
}

export function formatMarkdown({
  checkSchemaResult,
  config
}: {
  checkSchemaResult: CheckSchema_service_checkSchema;
  // This type _could_ be `ApolloConfig`, but we don't actually need all those fields. When does this matter?
  // When we're writing tests and we don't want to mock the entire `ApolloConfig` type and instead just want
  // to feed in what we actually _need_.
  config: {
    service: {
      name: string;
    };
    tag: string;
  };
}): string {
  // This will always return a negative number of days. Use `-` to make it positive.
  const days = -moment()
    .add(checkSchemaResult.diffToPrevious.validationConfig.from, "second")
    .diff(
      moment().add(
        checkSchemaResult.diffToPrevious.validationConfig.to,
        "second"
      ),
      "days"
    );

  const breakingChanges = checkSchemaResult.diffToPrevious.changes.filter(
    change => change.type === "FAILURE"
  );

  return `
### Apollo Service Check
🔄 Validated your local schema against schema tag \'${
    config.tag
  }\' on service \'${config.service.name}\'.
🔢 Compared **${
    checkSchemaResult.diffToPrevious.changes.length
  } schema changes** against operations seen over the **last ${
    days === 1 ? "day" : `${days} days`
  }**.
${
  breakingChanges.length > 0
    ? `❌ Found **${
        checkSchemaResult.diffToPrevious.changes.filter(
          change => change.type === "FAILURE"
        ).length
      } breaking changes** that would affect **${
        checkSchemaResult.diffToPrevious.affectedQueries.length
      } operations**`
    : `✅ Found **no breaking changes**.`
}

🔗 [View your service check details](${checkSchemaResult.targetUrl}).
`;
}

export default class ServiceCheck extends ProjectCommand {
  static aliases = ["schema:check"];
  static description =
    "Check a service against known operation workloads to find breaking changes";
  static flags = {
    ...ProjectCommand.flags,
    tag: flags.string({
      char: "t",
      description: "The published tag to check this service against"
    }),
    validationPeriod: flags.string({
      description:
        "The size of the time window with which to validate the schema against. You may provide a number (in seconds), or an ISO8601 format duration for more granularity (see: https://en.wikipedia.org/wiki/ISO_8601#Durations)"
    }),
    queryCountThreshold: flags.integer({
      description:
        "Minimum number of requests within the requested time window for a query to be considered."
    }),
    queryCountThresholdPercentage: flags.integer({
      description:
        "Number of requests within the requested time window for a query to be considered, relative to total request count. Expected values are between 0 and 0.05 (minimum 5% of total request volume)"
    }),
    json: flags.boolean({
      description:
        "Output result in json, which can then be parsed by CLI tools such as jq.",
      exclusive: ["markdown"]
    }),
    markdown: flags.boolean({
      description: "Output result in markdown.",
      exclusive: ["json"]
    })
  };

  async run() {
    const {
      gitContext,
      checkSchemaResult,
      config,
      shouldOutputJson,
      shouldOutputMarkdown
    } = await this.runTasks<TasksOutput>(({ config, flags, project }) => [
      {
        title: "Checking service for changes",
        task: async (ctx: TasksOutput) => {
          if (!config.name) {
            throw new Error("No service found to link to Engine");
          }

          const tag = flags.tag || config.tag || "current";
          const schema = await project.resolveSchema({ tag });
          ctx.gitContext = await gitInfo(this.log);

          const historicParameters = validateHistoricParams({
            validationPeriod: flags.validationPeriod,
            queryCountThreshold: flags.queryCountThreshold,
            queryCountThresholdPercentage: flags.queryCountThresholdPercentage
          });

          ctx.checkSchemaResult = await project.engine.checkSchema({
            id: config.name,
            // @ts-ignore
            // XXX Looks like TS should be generating ReadonlyArrays instead
            schema: introspectionFromSchema(schema).__schema,
            tag: flags.tag,
            gitContext: ctx.gitContext,
            frontend: flags.frontend || config.engine.frontend,
            ...(historicParameters && { historicParameters })
          });

          ctx.shouldOutputJson = !!flags.json;
          ctx.shouldOutputMarkdown = !!flags.markdown;
        }
      }
    ]);

    const {
      targetUrl,
      diffToPrevious: { changes, validationConfig }
    } = checkSchemaResult;
    const failures = changes.filter(({ type }) => type === ChangeType.FAILURE);

    if (shouldOutputJson) {
      return this.log(
        JSON.stringify({ targetUrl, changes, validationConfig }, null, 2)
      );
    } else if (shouldOutputMarkdown) {
      return this.log(formatMarkdown({ checkSchemaResult, config }));
    }

    if (changes.length === 0) {
      return this.log("\nNo changes present between schemas\n");
    }
    this.log("\n");
    table(changes.map(formatChange), {
      columns: [
        { key: "type", label: "Change" },
        { key: "code", label: "Code" },
        { key: "description", label: "Description" }
      ]
    });
    this.log("\n");
    if (targetUrl) {
      this.log(`View full details at: ${targetUrl}`);
    }
    // exit with failing status if we have failures
    if (failures.length > 0) {
      this.exit();
    }
    return;
  }
}
