
# Prisma PG Stream

Prisma Stream Client Extension for PostgreSQL

## Usage

First, install the necessary dependencies:

```sh
npm install @prisma/client prisma-pg-stream pg
```

### Stream Usage

The `.stream` method allows you to listen for specific database events on particular fields of a model. You can specify the fields to stream and the types of events to listen for.

#### Example

To listen for `INSERT`, `UPDATE`, and `DELETE` events on the `id`, `name`, and `email` fields of the `user` model:

```typescript
const stream = await prisma.user.stream(['id', 'name', 'email'], ['INSERT', 'UPDATE', 'DELETE']);

for await (const event of stream) {
    console.log(event);
    /*
    {
        operation: 'INSERT',
        timestamp: '2024-06-20T15:45:37.808Z',
        data: { id: 53, name: 'John Doe', email: 'john@example.com' }
    }
    */
}
```

This will start streaming `INSERT`, `UPDATE`, and `DELETE` events for the specified fields. You can handle the streamed events in an asynchronous loop as shown in the main example above.

### Supported Events

You can specify the following events to listen for:
- `INSERT`
- `UPDATE`
- `DELETE`
- Any combination of the above

### Supported Fields

You can stream events on any fields that the original model has. Simply provide an array of field names as the first argument to the `.stream` method.

### Note

This extension only works with PostgreSQL as the database engine. Make sure your Prisma setup is configured to use PostgreSQL.
