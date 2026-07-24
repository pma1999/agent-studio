#!/usr/bin/env python3
"""
INE API Client v2 - Interfaz completa para el Instituto Nacional de Estadistica
================================================================================
APIs: Tempus3 (JSON) + JAXI (PC-Axis) + SDC21 (Censos)
Uso:   python ine.py <comando> [argumento] [opciones]

Comandos:
  ops                          Listar operaciones
  buscar <texto>               Buscar operaciones
  tablas <id_op>               Listar tablas de una operacion
  tabla <id_tabla>             Info detallada de una tabla
  datos <id_tabla>             Descargar y mostrar datos de una tabla
  analizar <palabra>           Buscar y analizar tablas por palabra clave
  dependencia                  Analisis de proyeccion de dependientes
  --json                       Salida en JSON
  --todas                      Mostrar todos los anos
"""

import re, json, time, logging, sys, os
from pathlib import Path
from typing import Dict, List, Optional, Any, Union, Tuple
from datetime import datetime
from dataclasses import dataclass, field
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ============================================================================
# CONFIG
# ============================================================================
BASE_TEMPUS3 = "https://servicios.ine.es/wstempus/js/ES/"
BASE_JAXI = "https://www.ine.es/jaxiT3/"
PX_ENCODING = "iso-8859-1"
TIMEOUT = 30
MAX_RETRIES = 3
logger = logging.getLogger(__name__)
_cache_ops = None

# ============================================================================
# MODELOS
# ============================================================================
@dataclass
class Operacion:
    id: int; codigo_ioe: str; nombre: str; codigo: str; url: str = None
    def __str__(self): return f"[{self.id:>3}] {self.codigo:<10} {self.nombre}"

@dataclass
class Tabla:
    id: int; nombre: str; codigo: str = ""; periodicidad: str = None
    def __str__(self): return f"T{self.id:>5}: {self.nombre}"

@dataclass
class Serie:
    codigo: str; nombre: str; unidad: str; datos: List[Dict] = field(default_factory=list)

@dataclass
class TablaPX:
    titulo: str; contenido: str; unidad: str; decimales: int
    dimensiones: Dict[str, List[str]] = field(default_factory=dict)
    datos: List[float] = field(default_factory=list)
    metadatos: Dict[str, str] = field(default_factory=dict)
    archivo: str = ""

# ============================================================================
# HTTP CLIENT
# ============================================================================
def _sesion():
    s = requests.Session()
    retry = Retry(total=MAX_RETRIES, backoff_factor=1.0, status_forcelist=[429,500,502,503,504])
    s.mount("http://", HTTPAdapter(max_retries=retry))
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.headers.update({"User-Agent": "INE-API-Client/2.0", "Accept-Language": "es-ES,es"})
    return s
_s = _sesion()

def _get_json(url, params=None):
    r = _s.get(url, params=params, timeout=TIMEOUT); r.raise_for_status(); return r.json()

def _get_text(url, params=None):
    r = _s.get(url, params=params, timeout=TIMEOUT); r.raise_for_status(); return r.text

# ============================================================================
# API TEMPUS3
# ============================================================================
def listar_operaciones() -> List[Operacion]:
    global _cache_ops
    if _cache_ops: return _cache_ops
    data = _get_json(f"{BASE_TEMPUS3}OPERACIONES_DISPONIBLES?det=2")
    _cache_ops = [Operacion(id=item.get("Id",0), codigo_ioe=item.get("Cod_IOE",""),
                 nombre=item.get("Nombre",""), codigo=item.get("Codigo","")) for item in data]
    return _cache_ops

def buscar_operacion(termino: str) -> List[Operacion]:
    t = termino.lower()
    return [op for op in listar_operaciones() if t in op.nombre.lower() or t in op.codigo.lower()]

def obtener_operacion(codigo: Union[str,int]) -> Dict:
    return _get_json(f"{BASE_TEMPUS3}OPERACION/{codigo}")

def listar_tablas(codigo_op: Union[str,int]) -> List[Tabla]:
    for geo in [0, 1]:
        try:
            data = _get_json(f"{BASE_TEMPUS3}TABLAS_OPERACION/{codigo_op}", {"det":2, "geo":geo})
            if data: return [Tabla(id=item.get("Id",0), nombre=item.get("Nombre",""),
                            codigo=item.get("Codigo","")) for item in data]
        except: continue
    return []

def buscar_tablas(termino: str, max_ops: int = 50) -> List[Tabla]:
    """
    Busca tablas por palabra clave en:
    1. Operaciones del INE (Tempus3)
    2. Tablas JAXI conocidas (catálogo interno)
    """
    t = termino.lower()
    resultado = []
    # Buscar en operaciones Tempus3
    ops = listar_operaciones()[:max_ops]
    for op in ops:
        try:
            tabs = listar_tablas(op.id)
            for tab in tabs:
                if t in tab.nombre.lower():
                    tab.codigo = op.codigo
                    resultado.append(tab)
        except:
            continue
    # Buscar en catálogo de tablas JAXI conocidas por palabras clave
    _ampliar_busqueda_con_catalogo(t, resultado)
    return resultado

_CATALOGO_JAXI = {
    # Formato: "palabra_clave": [(id_tabla, "nombre")],
    "estado civil": [(76270, "Poblacion de 16+ por sexo, pais y estado civil")],
    "civil": [(76270, "Poblacion de 16+ por sexo, pais y estado civil")],
    "soltero": [(76270, "Poblacion de 16+ por sexo, pais y estado civil")],
    "casado": [(76270, "Poblacion de 16+ por sexo, pais y estado civil")],
    "divorci": [(76270, "Poblacion de 16+ por sexo, pais y estado civil")],
    "viudo": [(76270, "Poblacion de 16+ por sexo, pais y estado civil")],
    "censo anual": [(76270, "Poblacion de 16+ por sexo, pais y estado civil")],
    "poblacion": [
        (36643, "Poblacion residente por sexo, edad y ano"),
        (56934, "Poblacion residente por fecha, sexo y edad"),
        (76270, "Poblacion de 16+ por sexo, pais y estado civil"),
    ],
    "dependencia": [(36668, "Tasa de Dependencia por ano"), (36669, "Tasa Dependencia <16"), (36670, "Tasa Dependencia >64")],
    "envejecimiento": [(36667, "Indice de Envejecimiento por ano")],
    "edad media": [(36664, "Edad Media de la Poblacion")],
    "edad mediana": [(36665, "Edad Mediana de la Poblacion")],
    "inmigracion": [(36671, "Tasa Bruta de Inmigracion")],
    "emigracion": [(36673, "Tasa Bruta de Emigracion")],
    "mortalidad": [(36657, "Tasa Bruta de Mortalidad")],
    "natalidad": [(36656, "Edad Media a la Maternidad")],
    "crecimiento": [(36660, "Crecimiento de la Poblacion")],
    "saldo vegetativo": [(36661, "Saldo Vegetativo")],
    "saldo migratorio": [(36662, "Saldo Migratorio")],
    "activos": [(65082, "Activos por estado civil, sexo y grupo de edad")],
    "ocupados": [(65110, "Ocupados por estado civil, sexo y grupo de edad")],
    "paro": [(65082, "Activos por estado civil, sexo y grupo de edad")],
    "epa": [(65082, "Activos por estado civil, sexo y grupo de edad")],
    "hogar": [(60135, "Hogares por tamano del hogar")],
    "vivienda": [(432, "Indice de Precios de Vivienda en Alquiler")],
    "ipc": [(25, "Indice de Precios de Consumo")],
}

def _ampliar_busqueda_con_catalogo(termino: str, resultado: List[Tabla]):
    """Busca en el catalogo interno de tablas JAXI"""
    ids_ya = {t.id for t in resultado}
    for clave, tablas in _CATALOGO_JAXI.items():
        if clave in termino or termino in clave:
            for id_tabla, nombre in tablas:
                if id_tabla not in ids_ya:
                    resultado.append(Tabla(id=id_tabla, nombre=nombre, codigo="JAXI"))
                    ids_ya.add(id_tabla)

# ============================================================================
# API JAXI - PC-Axis
# ============================================================================
def _descargar_px(id_tabla: int, destino: str = None) -> str:
    url = f"{BASE_JAXI}files/t/es/px/{id_tabla}.px?nocab=1"
    texto = _get_text(url)
    if destino:
        Path(destino).write_text(texto, encoding=PX_ENCODING)
    return texto

def _extraer_valores_dimension(contenido: str) -> Dict[str, List[str]]:
    dims = {}
    idx = 0
    while True:
        start = contenido.find('VALUES("', idx)
        if start == -1: break
        paren_start = start + 8
        paren_end = contenido.find('")="', paren_start)
        if paren_end == -1: break
        nombre_dim = contenido[paren_start:paren_end]
        after_eq = paren_end + 3
        if after_eq >= len(contenido) or contenido[after_eq] != '"':
            idx = after_eq; continue
        data_start = after_eq + 1
        semic = contenido.find(';', data_start)
        if semic == -1: break
        bloque = contenido[data_start:semic]
        valores = []
        pos = 0
        while pos < len(bloque):
            c = bloque[pos]
            if c == '"':
                end = bloque.find('"', pos + 1)
                if end == -1:
                    v = bloque[pos+1:].strip()
                    if v: valores.append(v)
                    break
                v = bloque[pos+1:end].strip()
                if v and v != ',': valores.append(v)
                pos = end + 1
                if pos < len(bloque) and bloque[pos] == ',': pos += 1
            elif c == ',':
                pos += 1
            else:
                end = bloque.find('"', pos)
                if end == -1:
                    v = bloque[pos:].strip()
                    if v: valores.append(v)
                    break
                v = bloque[pos:end].strip()
                if v and v != ',': valores.append(v)
                pos = end
        if valores: dims[nombre_dim] = valores
        idx = semic + 1
    return dims

def parsear_px(contenido: str, archivo: str = "") -> TablaPX:
    titulo = _extract(r'TITLE="([^"]*)"', contenido)
    contenido_t = _extract(r'CONTENTS="([^"]*)"', contenido)
    unidad = _extract(r'UNITS="([^"]*)"', contenido)
    dec_str = _extract(r'DECIMALS=(\d+)', contenido)
    decimales = int(dec_str) if dec_str else 0
    dims = _extraer_valores_dimension(contenido)
    data_match = re.search(r'DATA=([^;]+);', contenido, re.DOTALL)
    datos = []
    if data_match:
        for t in data_match.group(1).split():
            t = t.strip()
            if t:
                try: datos.append(float(t))
                except: pass
    metadatos = {}
    for m in re.finditer(r'^([A-Z][A-Z_-]+)="([^"]*)"', contenido, re.MULTILINE):
        metadatos[m.group(1)] = m.group(2)
    return TablaPX(titulo=titulo or "", contenido=contenido_t or "", unidad=unidad or "",
                   decimales=decimales, dimensiones=dims, datos=datos, metadatos=metadatos, archivo=archivo)

def _extract(pattern: str, text: str) -> str:
    m = re.search(pattern, text); return m.group(1) if m else ""

def cargar_px(archivo: str) -> TablaPX:
    return parsear_px(Path(archivo).read_text(encoding=PX_ENCODING), archivo=archivo)

def descargar_tabla_px(id_tabla: int, guardar: bool = False) -> TablaPX:
    contenido = _descargar_px(id_tabla, destino=f"t{id_tabla}.px" if guardar else None)
    return parsear_px(contenido, archivo=f"t{id_tabla}.px" if guardar else "")

# ============================================================================
# UTILIDADES TABLAS PX
# ============================================================================
def px_a_serie(tabla: TablaPX) -> Dict:
    if not tabla.dimensiones:
        return {"clave": "item", "valores": list(range(len(tabla.datos))), "datos": tabla.datos}
    dim_name = list(tabla.dimensiones.keys())[0]
    dim_vals = list(tabla.dimensiones.values())[0]
    n = min(len(dim_vals), len(tabla.datos))
    return {"clave": dim_name, "valores": dim_vals[:n], "datos": tabla.datos[:n]}

def px_a_tabla_horizontal(tabla: TablaPX) -> List[Dict]:
    serie = px_a_serie(tabla)
    return [{serie["clave"]: serie["valores"][i],
             "valor": round(serie["datos"][i], tabla.decimales) if tabla.decimales else serie["datos"][i]}
            for i in range(len(serie["valores"]))]

def px_a_dataframe(tabla: TablaPX) -> List[Dict]:
    """Convierte tabla multidimensional a lista de dicts"""
    dims = tabla.dimensiones
    if not dims: return [{"valor": v} for v in tabla.datos]
    dim_names = list(dims.keys())
    dim_values = list(dims.values())
    strides = [1]
    for dv in reversed(dim_values): strides.insert(0, strides[0] * len(dv))
    strides = strides[1:]
    rows = []
    total = 1
    for dv in dim_values: total *= len(dv)
    for i, val in enumerate(tabla.datos):
        if i >= total: break
        row = {}
        remaining = i
        for j, dim_name in enumerate(dim_names):
            dim_size = len(dim_values[j])
            if j < len(dim_names) - 1:
                idx = remaining // strides[j]; remaining = remaining % strides[j]
            else: idx = remaining
            row[dim_name] = dim_values[j][idx]
        row["valor"] = round(val, tabla.decimales) if tabla.decimales else val
        rows.append(row)
    return rows

# ============================================================================
# ANALIZADOR INTELIGENTE
# ============================================================================
def analizar_tabla(id_tabla: int, json_out: bool = False) -> str:
    """
    Analiza una tabla automaticamente: detecta estructura, calcula porcentajes,
    muestra distribuciones. Funciona con tablas de 1, 2, 3 o 4 dimensiones.
    """
    try:
        px = descargar_tabla_px(id_tabla)
    except Exception as e:
        return f"Error descargando tabla {id_tabla}: {e}"

    if json_out:
        return json.dumps({
            "titulo": px.titulo, "unidad": px.unidad,
            "dimensiones": {k: {"valores": v, "count": len(v)} for k,v in px.dimensiones.items()},
            "datos": px.datos[:100],
            "total_celdas": len(px.datos)
        }, indent=2, ensure_ascii=False)

    lineas = []
    lineas.append("=" * 72)
    lineas.append(f"TABLA {id_tabla}: {px.titulo}")
    lineas.append(f"Unidad: {px.unidad}  |  Celdas: {len(px.datos):,}")
    lineas.append("=" * 72)

    for dim, vals in px.dimensiones.items():
        n = len(vals)
        muestra = ", ".join(vals[:5])
        if n > 5: muestra += f"... ({n} valores)"
        lineas.append(f"  {dim}: {muestra}")

    lineas.append("")
    ndims = len(px.dimensiones)

    if ndims == 0:
        lineas.append(f"  Valor unico: {px.datos[0] if px.datos else 'N/A'}")
    elif ndims == 1:
        # Tabla simple: mostrar todos los valores
        filas = px_a_tabla_horizontal(px)
        dim_name = list(px.dimensiones.keys())[0]
        lineas.append(f"{'='*72}")
        lineas.append(f"{dim_name:<25} {'Valor':>20} {'%':>10}")
        lineas.append(f"{'-'*60}")
        if filas:
            total = sum(f["valor"] for f in filas if isinstance(f["valor"], (int,float)))
            for f in filas:
                if isinstance(f["valor"], (int,float)) and total > 0:
                    pct = f["valor"] / total * 100
                    lineas.append(f"{f[dim_name]:<25} {f['valor']:>20,.2f} {pct:>9.2f}%")
                else:
                    lineas.append(f"{f[dim_name]:<25} {f['valor']:>20}")
    elif ndims == 2:
        # Tabla bidimensional: tabla cruzada
        dims_list = list(px.dimensiones.keys())
        dim1 = dims_list[0]; dim2 = dims_list[1]
        vals1 = px.dimensiones[dim1]; vals2 = px.dimensiones[dim2]
        n1, n2 = len(vals1), len(vals2)
        lineas.append(f"\nTabla cruzada: {dim1} x {dim2}")
        lineas.append(f"{dim1:<25} ", end=""); lineas[-1] += "".join(f"{v:<15}" for v in vals2[:6])
        lineas.append(f"{'-'*25}{'-'*15*min(6,n2)}")
        for i, v1 in enumerate(vals1[:20]):
            s = f"{v1:<25} "
            for j, v2 in enumerate(vals2[:6]):
                pos = i * n2 + j
                if pos < len(px.datos):
                    s += f"{px.datos[pos]:<15.2f}"
            lineas.append(s)
    elif ndims >= 3:
        # Tabla multidimensional: detectar dimensiones de interes
        dims_list = list(px.dimensiones.keys())
        # Buscar dimensiones tipicas
        dim_estado = None
        dim_sexo = None
        dim_periodo = None
        dim_edad = None
        for d in dims_list:
            dl = d.lower()
            if 'estado' in dl or 'civil' in dl: dim_estado = d
            elif 'sexo' in dl: dim_sexo = d
            elif 'periodo' in dl or 'año' in dl or 'ano' in dl or 'fecha' in dl: dim_periodo = d
            elif 'edad' in dl: dim_edad = d

        # Si es tabla de estado civil, usar analisis especializado
        if dim_estado:
            lineas.extend(_analizar_estado_civil(px, dims_list, dim_estado, dim_sexo, dim_periodo))
        else:
            # Mostrar estructura y primeros datos
            lineas.append(f"\nTabla {ndims}D: {', '.join(dims_list)}")
            lineas.append(f"Total celdas: {len(px.datos):,}")
            df = px_a_dataframe(px)
            lineas.append(f"\nPrimeros {min(20, len(df))} registros:")
            lineas.append("-" * 72)
            for row in df[:20]:
                s = " | ".join(f"{k}={v}" for k,v in row.items() if k != "valor")
                lineas.append(f"  {s}  ->  {row['valor']}")

    return "\n".join(lineas)

def _analizar_estado_civil(px, dims_list, dim_estado, dim_sexo, dim_periodo) -> List[str]:
    """Analisis especializado para tablas de estado civil"""
    lineas = []
    estados = px.dimensiones[dim_estado]
    periodos = px.dimensiones[dim_periodo] if dim_periodo else ["N/A"]
    sexos = px.dimensiones[dim_sexo] if dim_sexo else ["Total"]

    # Encontrar indices
    idx_total_pais = 0
    idx_total_sexo = sexos.index("Total") if "Total" in sexos else 0
    idx_total_est = estados.index("Total") if "Total" in estados else 0

    # Calcular strides
    dim_names = list(px.dimensiones.keys())
    dim_values = list(px.dimensiones.values())
    strides = [1]
    for dv in reversed(dim_values): strides.insert(0, strides[0] * len(dv))
    strides = strides[1:]

    def _pos(*indices) -> int:
        """Calcula posicion en el array plano dados los indices de cada dimension"""
        pos = 0
        for i, idx in enumerate(indices):
            pos += idx * strides[i]
        return pos

    # Obtener totales por periodo
    totales_periodo = {}
    for p_idx, p in enumerate(periodos):
        pos = _pos(idx_total_pais, idx_total_sexo, idx_total_est, p_idx)
        if pos < len(px.datos):
            totales_periodo[p] = px.datos[pos]

    lineas.append(f"\n--- POBLACION POR {dim_estado.upper()} ---")
    lineas.append(f"Ambito: {dim_names[0]} = {dim_values[0][0]}")
    lineas.append(f"Sexo: Total")
    lineas.append("")

    # Cabecera
    header = f"{'Estado civil':<30}"
    for p in periodos:
        header += f" {p:>15}"
    header += f" {'% (ult)':>10}"
    lineas.append(header)
    lineas.append("-" * (30 + 16 * len(periodos) + 10))

    for est in estados:
        if est == "Total": continue
        e_idx = dim_values[dims_list.index(dim_estado)].index(est)
        s = f"{est:<30}"
        for p_idx in range(len(periodos)):
            pos = _pos(idx_total_pais, idx_total_sexo, e_idx, p_idx)
            if pos < len(px.datos):
                s += f" {px.datos[pos]:>15,.0f}"
        # Ultimo periodo: porcentaje
        pos_ult = _pos(idx_total_pais, idx_total_sexo, e_idx, len(periodos)-1)
        total_ult = totales_periodo.get(periodos[-1], 1)
        if pos_ult < len(px.datos):
            pct = px.datos[pos_ult] / total_ult * 100
            s += f" {pct:>9.2f}%"
        lineas.append(s)

    # Fila total
    s = f"{'TOTAL':<30}"
    for p_idx, p in enumerate(periodos):
        if p in totales_periodo:
            s += f" {totales_periodo[p]:>15,.0f}"
    s += "   100.00%"
    lineas.append(s)

    # Por sexo
    if dim_sexo and len(sexos) > 1:
        lineas.append(f"\n--- POR SEXO ({periodos[-1]}) ---")
        lineas.append(f"{'Estado civil':<30} {'Hombres':<25} {'Mujeres':<25}")
        lineas.append("-" * 80)
        for est in estados:
            if est == "Total" or est == "No consta": continue
            e_idx = dim_values[dims_list.index(dim_estado)].index(est)
            h_idx = dim_values[dims_list.index(dim_sexo)].index("Hombres") if "Hombres" in sexos else 0
            m_idx = dim_values[dims_list.index(dim_sexo)].index("Mujeres") if "Mujeres" in sexos else 0
            p_idx = len(periodos) - 1  # ultimo periodo

            pos_h = _pos(idx_total_pais, h_idx, e_idx, p_idx)
            pos_m = _pos(idx_total_pais, m_idx, e_idx, p_idx)
            pos_h_tot = _pos(idx_total_pais, h_idx, idx_total_est, p_idx)
            pos_m_tot = _pos(idx_total_pais, m_idx, idx_total_est, p_idx)

            if pos_h < len(px.datos) and pos_m < len(px.datos):
                th = px.datos[pos_h_tot]; tm = px.datos[pos_m_tot]
                ph = px.datos[pos_h] / th * 100 if th else 0
                pm = px.datos[pos_m] / tm * 100 if tm else 0
                lineas.append(f"{est:<30} {px.datos[pos_h]:>10,.0f} ({ph:>5.1f}%)   {px.datos[pos_m]:>10,.0f} ({pm:>5.1f}%)")

    return lineas

# ============================================================================
# ANALISIS ESPECIFICO: PROYECCIONES DE DEPENDENCIA
# ============================================================================
TABLAS_PROP = {
    "dep_total": 36668, "dep_menor16": 36669, "dep_mayor64": 36670,
    "envejecimiento": 36667, "edad_media": 36664, "edad_mediana": 36665,
    "prop_mayor_edad": 36666, "tasa_natalidad": 36656, "tasa_mortalidad": 36657,
    "crecimiento": 36660, "saldo_vegetativo": 36661, "saldo_migratorio": 36662,
    "tasa_inmigracion": 36671, "tasa_emigracion": 36673, "pob_sexo_edad": 36643,
}

def analisis_dependencia(mostrar_todas: bool = True) -> str:
    """Analisis completo de la proyeccion de dependientes en Espana 2026-2076"""
    lineas = []
    try:
        px_dep = descargar_tabla_px(TABLAS_PROP["dep_total"])
        px_u16 = descargar_tabla_px(TABLAS_PROP["dep_menor16"])
        px_o64 = descargar_tabla_px(TABLAS_PROP["dep_mayor64"])
        px_envej = descargar_tabla_px(TABLAS_PROP["envejecimiento"])
    except Exception as e:
        return f"Error descargando tablas de proyeccion: {e}"

    s_dep = px_a_serie(px_dep)
    s_u16 = px_a_serie(px_u16)
    s_o64 = px_a_serie(px_o64)
    s_envej = px_a_serie(px_envej)

    anios = s_dep["valores"] if mostrar_todas else [a for a in s_dep["valores"]
        if a in ['2026','2030','2035','2040','2045','2050','2055','2060','2065','2070','2075','2076']]

    lineas.append("=" * 80)
    lineas.append("PROYECCIONES DE POBLACION - INE 2026-2076")
    lineas.append("Tasas de Dependencia e Indice de Envejecimiento")
    lineas.append("Fuente: INE - Proyecciones de Poblacion (publicado: 17/06/2026)")
    lineas.append("=" * 80)
    lineas.append(f"{'Ano':<6} {'Dep. Total':<12} {'<16 anos':<12} {'>64 anos':<12} {'Envejec.':<12}")
    lineas.append("-" * 80)

    for i, anio in enumerate(s_dep["valores"]):
        if anio in anios:
            lineas.append(f"{anio:<6} {s_dep['datos'][i]:>8.2f}%    {s_u16['datos'][i]:>6.2f}%    {s_o64['datos'][i]:>6.2f}%    {s_envej['datos'][i]:>7.2f}")

    d2026 = s_dep['datos'][s_dep['valores'].index('2026')]
    d2076 = s_dep['datos'][s_dep['valores'].index('2076')]
    o2026 = s_o64['datos'][s_dep['valores'].index('2026')]
    o2076 = s_o64['datos'][s_dep['valores'].index('2076')]
    u2026 = s_u16['datos'][s_dep['valores'].index('2026')]
    u2076 = s_u16['datos'][s_dep['valores'].index('2076')]
    e2026 = s_envej['datos'][s_dep['valores'].index('2026')]
    e2076 = s_envej['datos'][s_dep['valores'].index('2076')]

    lineas.extend([
        "-" * 80,
        "CONCLUSIONES:",
        f"  - Tasa de dependencia total: {d2026:.2f}% (2026) -> {d2076:.2f}% (2076)",
        f"    Incremento: {d2076 - d2026:+.2f} puntos porcentuales",
        f"  - Dependencia infantil (<16): {u2026:.2f}% -> {u2076:.2f}% (estable)",
        f"  - Dependencia mayores (>64): {o2026:.2f}% -> {o2076:.2f}% (se dispara)",
        f"  - Indice de envejecimiento: {e2026:.0f} -> {e2076:.0f} (x{e2076/e2026:.1f})",
        "=" * 80,
    ])
    return "\n".join(lineas)

# ============================================================================
# CLI
# ============================================================================
def cli():
    import argparse
    parser = argparse.ArgumentParser(
        description="Cliente API del INE v2",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    parser.add_argument("comando", nargs="?", help="Comando: ops, buscar, tablas, tabla, datos, analizar, dependencia")
    parser.add_argument("argumento", nargs="?", help="Argumento del comando")
    parser.add_argument("--json", action="store_true", help="Salida JSON")
    parser.add_argument("--todas", action="store_true", help="Mostrar todos los anos")
    args = parser.parse_args()

    if not args.comando:
        parser.print_help(); return

    cmd = args.comando.lower()
    try:
        if cmd == "ops":
            ops = listar_operaciones()
            print(f"\nTotal: {len(ops)} operaciones\n")
            for op in ops: print(op)

        elif cmd == "buscar":
            if not args.argumento: print("Error: necesita texto de busqueda"); return
            # Buscar primero en operaciones
            ops = buscar_operacion(args.argumento)
            print(f"\n--- OPERACIONES con '{args.argumento}' ({len(ops)} resultados) ---\n")
            for op in ops: print(f"  {op}")

            # Buscar en tablas
            print(f"\n--- TABLAS con '{args.argumento}' (buscando en {min(30, len(listar_operaciones()))} operaciones...) ---\n")
            tabs = buscar_tablas(args.argumento, max_ops=30)
            if not tabs:
                print("  (sin resultados en tablas)\n")
            else:
                print(f"  {len(tabs)} tablas encontradas:\n")
                for t in tabs[:20]:
                    print(f"  T{t.id:>5}: {t.nombre}")
                if len(tabs) > 20:
                    print(f"  ... y {len(tabs)-20} mas")

        elif cmd == "tablas":
            if not args.argumento: print("Error: necesita codigo de operacion"); return
            tabs = listar_tablas(args.argumento)
            print(f"\nTablas de operacion {args.argumento}: {len(tabs)}\n")
            for t in tabs: print(f"  {t}")

        elif cmd == "tabla":
            if not args.argumento: print("Error: necesita ID de tabla"); return
            print(analizar_tabla(int(args.argumento), json_out=args.json))

        elif cmd == "datos":
            if not args.argumento: print("Error: necesita ID de tabla"); return
            px = descargar_tabla_px(int(args.argumento))
            if args.json:
                print(json.dumps({"titulo": px.titulo, "datos": px_a_tabla_horizontal(px),
                    "dimensiones": px.dimensiones}, indent=2, ensure_ascii=False))
                return
            filas = px_a_tabla_horizontal(px)
            dim_name = list(px.dimensiones.keys())[0] if px.dimensiones else "item"
            print(f"\n{px.titulo}")
            print(f"Unidad: {px.unidad}  |  {len(filas)} registros\n")
            for f in filas:
                print(f"{f.get(dim_name,''):<25} {f['valor']}")

        elif cmd == "analizar":
            if not args.argumento: print("Error: necesita texto de busqueda"); return
            tabs = buscar_tablas(args.argumento, max_ops=50)
            if not tabs:
                print(f"No se encontraron tablas para '{args.argumento}'")
                return
            # Ordenar: preferir catalogo JAXI (mas relevantes), luego coincidencia exacta
            t = args.argumento.lower()
            def _score(tab):
                n = tab.nombre.lower()
                s = 0
                if tab.codigo == "JAXI": s -= 100  # catalogo tiene prioridad
                if t in n: s -= 10
                # Preferir tablas con mas palabras coincidentes
                for palabra in t.split():
                    if palabra in n: s -= 5
                return s
            tabs.sort(key=_score)
            print(f"\nSe encontraron {len(tabs)} tablas para '{args.argumento}'")
            print(f"Mostrando las mas relevantes:\n")
            for tab in tabs[:8]:
                print(f"  [{tab.id:>5}] {tab.nombre}")
            if len(tabs) > 8:
                print(f"  ... y {len(tabs)-8} mas")
            print()
            # Intentar analizar la mejor tabla, si falla probar siguiente
            for mejor in tabs[:5]:
                try:
                    print(f"Analizando tabla {mejor.id}...\n")
                    resultado = analizar_tabla(mejor.id)
                    print(resultado)
                    break
                except Exception as e:
                    print(f"  (tabla {mejor.id} no disponible: {e})")
                    continue

        elif cmd == "dependencia":
            print(analisis_dependencia(mostrar_todas=args.todas))

        else:
            print(f"Comando desconocido: {cmd}")
            parser.print_help()

    except Exception as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        if "--debug" in sys.argv:
            import traceback; traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        cli()
    else:
        # Demo: mostrar resumen de dependencia
        print(analisis_dependencia(mostrar_todas=False))