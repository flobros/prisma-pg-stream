import { Prisma, PrismaClient, PrismaClientExtends } from "@prisma/client/extension";
import { DefaultArgs } from "@prisma/client/runtime/library";
import { Client } from 'pg';
import util from 'util';

type OperationType = 'INSERT' | 'UPDATE' | 'DELETE';

// Utility function to sanitize table names
function sanitizeTableName(tableName: string): string {
    return tableName.replace(/[^a-zA-Z0-9_]/g, '');
}

// Utility function to sanitize field names
function sanitizeFieldName(fieldName: string): string {
    return fieldName.replace(/[^a-zA-Z0-9_]/g, '');
}

function checkFieldsValidForTableNameWithinPrisma(allowedFields: string[], fields: string[]) {
    return fields.forEach((field: string) => {
        if (!allowedFields.includes(field)) {
            throw new Error(`Field "${field}" is not valid for the table`);
        }
    });
}

// Setup function to create the function and trigger (assumes table exists)
async function setupTable(client: Client, tableName: string, fields: string[], selectedOperations: string[] = ['INSERT', 'UPDATE', 'DELETE']) {
    const sanitizedTableName = sanitizeTableName(tableName);
    const functionName = `notify_${sanitizedTableName}_changes`;
    const triggerName = `${sanitizedTableName}_changes_trigger`;
    const operations = selectedOperations.join(' OR ');

    // Handle case when fields array is empty or contains '*'
    const jsonFields = fields.length === 0 || fields.includes('*')
        ? 'row_to_json(NEW)'
        : `json_build_object(${fields.map(field => `'${sanitizeFieldName(field)}', NEW."${sanitizeFieldName(field)}"`).join(', ')})`;

    try {
        // Create a function to send NOTIFY events for the table with specified fields, operation type, and timestamp
        await client.query(`
          CREATE OR REPLACE FUNCTION "${functionName}"()
          RETURNS TRIGGER AS $$
          BEGIN
            PERFORM pg_notify(
              '${sanitizedTableName}_changes',
              json_build_object(
                'operation', TG_OP,
                'timestamp', to_char(current_timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'data', CASE WHEN TG_OP = 'DELETE' THEN row_to_json(OLD) ELSE ${jsonFields} END
              )::text
            );
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
        `);

        // Drop the trigger if it exists, then create it
        await client.query(`
          DO $$
          BEGIN
            IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${triggerName}') THEN
              DROP TRIGGER "${triggerName}" ON "${sanitizedTableName}";
            END IF;
            CREATE TRIGGER "${triggerName}"
            AFTER ${operations} ON "${sanitizedTableName}"
            FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
          END
          $$;
        `);

    } catch (error) {
        console.error(`Error setting up table "${sanitizedTableName}":`, error);
        throw error;
    }
}

// Cleanup function to remove the trigger and function
async function cleanupTable(client: Client, tableName: string) {
    const sanitizedTableName = sanitizeTableName(tableName);
    const functionName = `notify_${sanitizedTableName}_changes`;
    const triggerName = `${sanitizedTableName}_changes_trigger`;

    try {
        await client.query(`
          DROP TRIGGER IF EXISTS "${triggerName}" ON "${sanitizedTableName}";
          DROP FUNCTION IF EXISTS "${functionName}";
        `);

        console.log(`Cleanup completed for table "${sanitizedTableName}"`);
    } catch (error) {
        console.error(`Error during cleanup for table "${sanitizedTableName}":`, error);
        throw error;
    }
}

const streamExtension = Prisma.defineExtension((client: PrismaClientExtends<DefaultArgs>) => {
    //@ts-ignore
    if (client.$parent._engineConfig.activeProvider !== 'postgresql') {
        throw new Error('This extension requires PostgreSQL as the active provider');
    }
    return client.$extends({
        model: {
            $allModels: {
                async stream<T>(this: T, fields: string[] = ['*'], operations: OperationType[] = ['INSERT', 'UPDATE', 'DELETE']) {
                    const context = Prisma.getExtensionContext(this) as any;
                    const tableName = (client as PrismaClient)._runtimeDataModel.models[context.name].dbName;
                    const model = (client as PrismaClient)._runtimeDataModel.models[context.name];
                    const allowedFields = model.fields.map((field: { name: string }) => field.name);
                    checkFieldsValidForTableNameWithinPrisma(allowedFields, fields)

                    const pgClient = new Client({
                        connectionString: process.env.DATABASE_URL,
                    });

                    let isListening = true;

                    try {
                        await pgClient.connect();
                        await setupTable(pgClient, tableName, fields, operations);

                        const asyncIterator = {
                            async *[Symbol.asyncIterator]() {
                                const events: any[] = [];
                                let resolveNext: ((value: any) => void) | null = null;

                                pgClient.on('notification', (msg) => {
                                    if (msg.payload) {
                                        const payload = JSON.parse(msg.payload);
                                        events.push(payload);
                                        if (resolveNext) {
                                            resolveNext(payload);
                                            resolveNext = null;
                                        }
                                    }
                                });

                                await pgClient.query(`LISTEN ${tableName}_changes`);

                                while (isListening) {
                                    if (events.length > 0) {
                                        const event = events.shift();
                                        yield event;
                                    } else {
                                        await new Promise<any>((resolve) => {
                                            console.log('Waiting for next event...');
                                            resolveNext = resolve;
                                        });
                                    }
                                }
                            },
                            async close() {
                                isListening = false;
                                await pgClient.query(`UNLISTEN ${tableName}_changes`);
                                await cleanupTable(pgClient, tableName);
                                await pgClient.end();
                            }
                        };

                        return asyncIterator;
                    } catch (error) {
                        console.error(`Error streaming table "${tableName}":`, error);
                        throw error;
                    }
                },
            },
        },
    });
});

export default streamExtension;
