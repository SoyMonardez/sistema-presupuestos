// Schemas JSON de las respuestas de IA.
//
// Claude los usa para garantizar la forma de la respuesta (output_config.format);
// Groq trabaja con json_object y el prompt describiendo la forma, así que le
// alcanza con que el prompt esté bien escrito.
//
// Ojo con qué tareas llevan schema: solo las que devuelven objetos donde TODOS
// los campos son siempre reales. Las operaciones de edición (add/update/remove/
// convert) NO llevan schema a propósito — ver la nota al final del archivo.

const ITEM = {
    type: 'object',
    properties: {
        name:       { type: 'string' },
        detail:     { type: 'string' },
        quantity:   { type: 'number' },
        unit:       { type: 'string' },
        unit_price: { type: 'number' },
    },
    required: ['name', 'detail', 'quantity', 'unit', 'unit_price'],
    additionalProperties: false,
};

export const ITEMS_SCHEMA = {
    type: 'object',
    properties: { items: { type: 'array', items: ITEM } },
    required: ['items'],
    additionalProperties: false,
};

export const TEXTS_SCHEMA = {
    type: 'object',
    properties: { texts: { type: 'array', items: { type: 'string' } } },
    required: ['texts'],
    additionalProperties: false,
};

export const SUGGESTIONS_SCHEMA = {
    type: 'object',
    properties: {
        suggestions: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name:       { type: 'string' },
                    unit:       { type: 'string' },
                    unit_price: { type: 'number' },
                },
                required: ['name', 'unit', 'unit_price'],
                additionalProperties: false,
            },
        },
    },
    required: ['suggestions'],
    additionalProperties: false,
};

export const CLIENT_SCHEMA = {
    type: 'object',
    properties: {
        role:    { type: 'string' },
        address: { type: 'string' },
        cp:      { type: 'string' },
        phone:   { type: 'string' },
        email:   { type: 'string' },
    },
    required: ['role', 'address', 'cp', 'phone', 'email'],
    additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Por qué las operaciones de edición NO llevan schema
// ---------------------------------------------------------------------------
// Un schema estricto exige que todos los campos estén presentes. Pero normalizeOp
// distingue "campo ausente" (no lo toques) de "campo con valor" (cambialo):
//
//     if (op.name !== undefined) fields.name = ...
//
// Con un schema estricto, un pedido de "cambiale el precio al item 3" llegaría
// igual con name: "" y borraría el nombre del item. La alternativa sería inventar
// una convención de centinelas ("" = no cambies), que es frágil y silenciosa.
//
// Así que las ops se piden por prompt — que ya las describe con precisión — y se
// validan con normalizeOp, que descarta cualquier cosa que no reconozca. La red
// de seguridad es la validación, no el schema.
