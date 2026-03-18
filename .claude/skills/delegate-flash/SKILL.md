---
name: delegate-flash
description: |
  Genera instrucciones optimizadas para delegar tareas menores a Gemini Flash.
  Define que tareas son seguras para Flash, formatea prompts ultra-especificos,
  y valida el output al regresar. Usado por Xavier para descargar trabajo
  mecanico al modelo mas rapido y barato disponible.
allowed-tools:
  - read
  - write
---

# /delegate-flash — Delegacion a Modelo Rapido

Genera prompts ready-to-paste para delegar tareas mecanicas a Gemini Flash (u otro modelo rapido).
La regla cardinal: **input exacto → output exacto**. Sin ambiguedad, sin razonamiento abierto.

**Paso 1: Identificar si la tarea es apta para Flash.**
**Paso 2: Generar prompt optimizado con template.**
**Paso 3: Validar output cuando regrese.**

---

## Task Routing Matrix

### Green Zone (Seguro para Flash)

Tareas mecanicas con input/output bien definido:

| Tarea | Input | Output |
|-------|-------|--------|
| Barrel exports | Lista de archivos en un directorio | `index.ts` con re-exports |
| Types desde SQL | `CREATE TABLE` statement | Interfaces TS + Zod schemas |
| Tests unitarios simples | Funcion pura con tipos claros | Tests con patron AAA |
| Mock data | Interface/Type de TypeScript | Array de 5-10 objetos mock |
| Componente presentacional | Nombre + props + descripcion visual | Componente React puro (sin logica) |
| Zod desde Interface | Interface TypeScript | Zod schema equivalente |
| SQL desde schema | Descripcion de tabla + campos | `CREATE TABLE` con tipos correctos |
| Traduccion | Strings en un idioma | Strings en otro idioma |
| JSDoc | Funcion existente | Comentario JSDoc completo |
| Regex | Descripcion de patron | Expresion regular con tests |

### Red Zone (NUNCA delegar a Flash)

| Tarea | Razon |
|-------|-------|
| Auth / seguridad | Errores de seguridad son criticos e invisibles |
| RLS policies | Requiere entender el modelo de permisos completo |
| Debugging multi-archivo | Flash no tiene contexto del proyecto |
| Decisiones arquitecturales | Requiere razonamiento profundo |
| Server Actions complejas | Patron de 4 pasos requiere entender auth + validation |
| Composicion de skills | Meta-razonamiento sobre el sistema |
| Refactoring | Requiere entender dependencias y side effects |
| Cualquier tarea con "depende" | Si la respuesta depende de contexto, NO es para Flash |

### Gray Zone (Con supervision)

| Tarea | Condicion |
|-------|-----------|
| Hook simple (useState + useEffect) | Solo si la logica es fetch → set state |
| Query SQL simple | Solo SELECT con filtros basicos |
| Componente con logica minima | Solo condicionales simples en JSX |
| Config files | Solo si el formato es exacto y conocido |

Gray Zone = generar con Flash, SIEMPRE revisar antes de integrar.

---

## Prompt Templates

Cada template sigue la misma estructura para maximizar la calidad de Flash:

```
ROLE: [que es Flash en este contexto]
TASK: [que hacer exactamente]
INPUT: [los datos concretos]
OUTPUT FORMAT: [formato exacto esperado]
CONSTRAINTS: [reglas que debe seguir]
EXAMPLE: [1-shot example completo]
```

### Template 1: Barrel Export Generator

```
ROLE: Eres un generador de archivos index.ts para TypeScript.

TASK: Genera un archivo index.ts que re-exporte todos los modulos listados.

INPUT:
Directorio: src/features/{name}/components/
Archivos:
- {Name}List.tsx (export function {Name}List)
- {Name}Card.tsx (export function {Name}Card)
- {Name}Form.tsx (export function {Name}Form)

OUTPUT FORMAT: Solo codigo TypeScript, sin explicacion, sin markdown fences.

CONSTRAINTS:
- Usar named exports, no default exports
- Un export por linea
- Orden alfabetico

EXAMPLE:
Input: archivos UserList.tsx, UserCard.tsx
Output:
export { UserCard } from './UserCard'
export { UserList } from './UserList'
```

### Template 2: Types desde SQL

```
ROLE: Eres un generador de tipos TypeScript + Zod schemas a partir de SQL.

TASK: Dado un CREATE TABLE de PostgreSQL, genera:
1. Un Zod schema completo
2. Un schema de creacion (sin id, user_id, timestamps)
3. Un schema de update (parcial + id requerido)
4. Types derivados con z.infer

INPUT:
[PEGAR CREATE TABLE AQUI]

OUTPUT FORMAT: Solo codigo TypeScript, sin explicacion.

CONSTRAINTS:
- Importar z desde 'zod'
- uuid → z.string().uuid()
- text NOT NULL → z.string().min(1)
- text nullable → z.string().nullable().optional()
- timestamptz → z.string().datetime()
- boolean DEFAULT → z.boolean().default(value)
- CHECK con enum → z.enum([valores])
- Nombres en camelCase para TS

EXAMPLE:
Input:
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  title text NOT NULL,
  done boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

Output:
import { z } from 'zod'

export const taskSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  title: z.string().min(1, 'Titulo requerido'),
  done: z.boolean().default(false),
  created_at: z.string().datetime(),
})

export const createTaskSchema = taskSchema.omit({
  id: true,
  user_id: true,
  created_at: true,
})

export const updateTaskSchema = createTaskSchema.partial().extend({
  id: z.string().uuid(),
})

export type Task = z.infer<typeof taskSchema>
export type CreateTask = z.infer<typeof createTaskSchema>
export type UpdateTask = z.infer<typeof updateTaskSchema>
```

### Template 3: Test Generator

```
ROLE: Eres un generador de tests unitarios con Vitest.

TASK: Genera tests para la funcion dada, usando patron AAA (Arrange, Act, Assert).

INPUT:
[PEGAR FUNCION AQUI]

OUTPUT FORMAT: Solo codigo TypeScript, sin explicacion.

CONSTRAINTS:
- Usar describe/it de Vitest
- Patron AAA con comentarios // Arrange, // Act, // Assert
- Minimo 3 tests: happy path, edge case, error case
- Import desde ruta relativa
- No mockear a menos que sea necesario

EXAMPLE:
Input:
export function calculateTotal(items: { price: number }[], taxRate: number): number {
  const subtotal = items.reduce((sum, item) => sum + item.price, 0)
  return Math.round(subtotal * (1 + taxRate) * 100) / 100
}

Output:
import { describe, it, expect } from 'vitest'
import { calculateTotal } from './calculateTotal'

describe('calculateTotal', () => {
  it('should calculate total with tax', () => {
    // Arrange
    const items = [{ price: 100 }, { price: 200 }]
    const taxRate = 0.1

    // Act
    const result = calculateTotal(items, taxRate)

    // Assert
    expect(result).toBe(330)
  })

  it('should return 0 for empty array', () => {
    // Arrange & Act
    const result = calculateTotal([], 0.1)

    // Assert
    expect(result).toBe(0)
  })

  it('should handle zero tax rate', () => {
    // Arrange
    const items = [{ price: 50 }]

    // Act
    const result = calculateTotal(items, 0)

    // Assert
    expect(result).toBe(50)
  })
})
```

### Template 4: Mock Data Generator

```
ROLE: Eres un generador de datos mock realistas para TypeScript.

TASK: Genera un array de datos mock para el tipo dado.

INPUT:
[PEGAR TYPE/INTERFACE AQUI]

OUTPUT FORMAT: Solo codigo TypeScript, sin explicacion.

CONSTRAINTS:
- Generar 5 items variados y realistas
- UUIDs validos (usar formato xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)
- Fechas ISO realistas
- Strings descriptivos (no "test1", "test2")
- Cubrir todos los valores posibles de enums
- Export como const

EXAMPLE:
Input:
type Project = { id: string; title: string; status: 'draft' | 'active' | 'archived'; created_at: string }

Output:
export const mockProjects: Project[] = [
  { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', title: 'Website Redesign', status: 'active', created_at: '2026-01-15T10:30:00Z' },
  { id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', title: 'Mobile App MVP', status: 'draft', created_at: '2026-02-01T14:00:00Z' },
  { id: 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f', title: 'API Integration', status: 'active', created_at: '2026-01-20T09:15:00Z' },
  { id: 'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a', title: 'Legacy Migration', status: 'archived', created_at: '2025-11-10T16:45:00Z' },
  { id: 'e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8a9b', title: 'Dashboard Analytics', status: 'draft', created_at: '2026-02-20T11:00:00Z' },
]
```

### Template 5: Component Shell Generator

```
ROLE: Eres un generador de componentes React presentacionales con TypeScript + Tailwind.

TASK: Genera un componente React puro (sin estado, sin efectos) basado en las props dadas.

INPUT:
Nombre: [Nombre del componente]
Props: [Lista de props con tipos]
Descripcion visual: [Como debe verse]

OUTPUT FORMAT: Solo codigo TSX, sin explicacion.

CONSTRAINTS:
- 'use client' solo si tiene onClick o interactividad
- Interface Props explicita
- Tailwind CSS para estilos
- Sin useState, sin useEffect
- Export named (no default)

EXAMPLE:
Input:
Nombre: StatCard
Props: label: string, value: number, trend: 'up' | 'down'
Descripcion: Card con label arriba, valor grande al centro, flecha de tendencia

Output:
interface StatCardProps {
  label: string
  value: number
  trend: 'up' | 'down'
}

export function StatCard({ label, value, trend }: StatCardProps) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</p>
      <span className={`text-sm ${trend === 'up' ? 'text-green-600' : 'text-red-600'}`}>
        {trend === 'up' ? '↑' : '↓'}
      </span>
    </div>
  )
}
```

### Template 6: Zod desde Interface

```
ROLE: Eres un conversor de interfaces TypeScript a Zod schemas.

TASK: Convierte la interface dada a un Zod schema equivalente.

INPUT:
[PEGAR INTERFACE AQUI]

OUTPUT FORMAT: Solo codigo TypeScript, sin explicacion.

CONSTRAINTS:
- import { z } from 'zod'
- string → z.string() (agregar .min(1) si es requerido)
- number → z.number()
- boolean → z.boolean()
- optional (?) → .optional()
- nullable → .nullable()
- arrays → z.array(z.tipo())
- union types → z.union() o z.enum()
- nested objects → z.object() inline

EXAMPLE:
Input:
interface User {
  id: string
  name: string
  email: string
  age?: number
  roles: ('admin' | 'user')[]
}

Output:
import { z } from 'zod'

export const userSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().positive().optional(),
  roles: z.array(z.enum(['admin', 'user'])),
})

export type User = z.infer<typeof userSchema>
```

---

## Quality Gate

Cuando Flash devuelve output, SIEMPRE validar antes de integrar:

### Checklist Automatica

```
1. TIPOS: ¿Compila sin errores? (verificar imports, tipos correctos)
2. IMPORTS: ¿Las rutas de import son correctas para ESTE proyecto?
3. PATRONES: ¿Sigue las convenciones del proyecto? (naming, estructura)
4. SEGURIDAD: ¿No introduce vulnerabilidades? (especialmente en Gray Zone)
5. COMPLETITUD: ¿Cubre todos los campos/casos del input?
```

### Protocolo de Validacion

```
Output de Flash llega al chat
    │
    ├─ Green Zone task → Quick review (30 seg) → Integrar
    │
    ├─ Gray Zone task → Full review → Corregir si necesario → Integrar
    │
    └─ Si tiene errores:
         → Claude corrige directamente
         → NO re-enviar a Flash (mas lento que corregir)
         → Documentar el patron de error para mejorar template
```

---

## Flujo de Ejecucion

```
1. IDENTIFICAR — ¿La tarea esta en el Green Zone?
   - Si NO → ejecutar con Claude directamente. FIN.
   - Si SI → continuar.

2. SELECCIONAR TEMPLATE — ¿Cual de los 6 templates aplica?

3. PREPARAR INPUT — Leer archivos necesarios del proyecto:
   - SQL schema, interfaces, funciones a testear, etc.

4. GENERAR PROMPT — Rellenar template con el input concreto.
   - Mostrar al usuario el prompt completo, ready-to-paste.

5. ESPERAR — Usuario copia prompt a Flash, obtiene output, lo trae de vuelta.

6. VALIDAR — Aplicar Quality Gate checklist.

7. INTEGRAR o CORREGIR — Segun resultado de la validacion.
```

---

## Como Pedir Delegacion

El usuario puede invocar este skill de dos formas:

1. **Directa**: "/delegate-flash" o "genera prompt para Flash"
2. **Via Xavier**: Xavier detecta tarea del Green Zone y sugiere delegacion

Cuando Xavier sugiere, usa este formato:
```
"Esta tarea (generar types desde SQL) es candidata para Flash.
¿Quieres que genere el prompt optimizado?"
```

---

## Mensaje Final

```
Prompt generado para Flash!

Template: {nombre_template}
Input: {descripcion_corta}

--- COPIAR DESDE AQUI ---
{prompt_completo}
--- HASTA AQUI ---

Cuando Flash responda, pega el output aqui y lo valido antes de integrarlo.
```
