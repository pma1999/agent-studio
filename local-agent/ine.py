#!/usr/bin/env python3
"""
INE API Client - Interfaz completa para el Instituto Nacional de Estadística
================================================================================
APIs: Tempus3 (JSON) + JAXI (PC-Axis)
"""

import re, json, time, logging, sys
from pathlib import Path
from typing import Dict, List, Optional, Any, Union, Tuple
from datetime import datetime
from dataclasses import dataclass, field
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ============================================================================
# CONFIGURACION
# ============================================================================
BASE_TEMPUS3 = "https://servicios.ine.es/wstempus/js/ES/"
BASE_JAXI = "https://www.ine.es/jaxiT3/"
PX_ENCODING = "iso-8859-1"
TIMEOUT = 30
MAX_RETRIES = 3
logger = logging.getLogger(__name__)

# ============================================================================
# MODELOS
# ============================================================================
@dataclass
class Operacion:
    id: int; codigo_ioe: str; nombre: str; codigo: str; url: str = None
    def __str__(self): return f"[{self.id}] {self.codigo}: {self.nombre}"

@dataclass
class Tabla:
    id: int; nombre: str; codigo: str = ""; periodicidad: str = None
    def __str__(self): return f"T{self.id}: {self.nombre}"

@dataclass
class Serie:
    codigo: str; nombre: str; unidad: str; datos: List[Dict] = field(default_factory=list)
    def __str__(self): return f"{self.codigo}: {self.nombre} ({len(self.datos)} obs)"

@dataclass
class TablaPX:
    titulo: str; contenido: str; unidad: str; decimales: int
    dimensiones: Dict[str, List[str]] = field(default_factory=dict)
    datos: List[float] = field(default_factory=list)
    metadatos: Dict[str, str] = field(default_factory=dict)
    archivo: str = ""
    def __str__(self): return f"PX: {self.titulo} ({len(self.datos)} celdas)"

# ============================================================================
# CLIENTE HTTP
# ============================================================================
def _crear_sesion():
    s = requests.Session()
    retry = Retry(total=MAX_RETRIES, backoff_factor=1.0, status_forcelist=[429,500,502,503,504])
    s.mount("http://", HTTPAdapter(max_retries=retry))
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.headers.update({"User-Agent": "INE-API-Client/1.0", "Accept-Language": "es-ES,es"})
    return s

_sesion = _crear_sesion()

def _get_json(url, params=None):
    r = _sesion.get(url, params=params, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()

def _get_text(url, params=None):
    r = _sesion.get(url, params=params, timeout=TIMEOUT)
    r.raise_for_status()
    return r.text

# ============================================================================
# API TEMPUS3 - OPERACIONES
# ============================================================================
def listar_operaciones(det=2, geo=0) -> List[Operacion]:
    """Lista todas las operaciones estadísticas disponibles"""
    data = _get_json(f"{BASE_TEMPUS3}OPERACIONES_DISPONIBLES", {"det": det, "geo": geo})
    ops = []
    for item in data:
        ops.append(Operacion(
            id=item.get("Id",0), codigo_ioe=item.get("Cod_IOE",""),
            nombre=item.get("Nombre",""), codigo=item.get("Codigo",""),
            url=item.get("Url")))
    return ops

def buscar_operacion(termino: str) -> List[Operacion]:
    """Busca operaciones por nombre o código"""
    t = termino.lower()
    return [op for op in listar_operaciones() if t in op.nombre.lower() or t in op.codigo.lower()]

def obtener_operacion(codigo: Union[str,int], det=2) -> Dict:
    return _get_json(f"{BASE_TEMPUS3}OPERACION/{codigo}", {"det": det})

def listar_tablas(codigo_op: Union[str,int], det=2, geo=0) -> List[Tabla]:
    """Lista tablas de una operación"""
    data = _get_json(f"{BASE_TEMPUS3}TABLAS_OPERACION/{codigo_op}", {"det": det, "geo": geo})
    return [Tabla(id=item.get("Id",0), nombre=item.get("Nombre",""),
                  codigo=item.get("Codigo",""), periodicidad=item.get("Periodicidad"))
            for item in data]

# ============================================================================
# API TEMPUS3 - DATOS
# ============================================================================
def datos_tabla(id_tabla: int, nult=None, det=1, tip="A",
                fecha_ini=None, fecha_fin=None) -> List[Serie]:
    """Obtiene datos de una tabla completa"""
    params = {"det": det, "tip": tip}
    if nult: params["nult"] = nult
    if fecha_ini and fecha_fin: params["date"] = f"{fecha_ini}:{fecha_fin}"
    elif fecha_ini: params["date"] = f"{fecha_ini}:"
    
    data = _get_json(f"{BASE_TEMPUS3}DATOS_TABLA/{id_tabla}", params)
    series = []
    for item in data:
        series.append(Serie(
            codigo=item.get("COD",""), nombre=item.get("Nombre",""),
            unidad=item.get("T3_Unidad",""), datos=item.get("Data",[])))
    return series

def datos_serie(codigo: str, nult=None, det=1, tip="A",
                fecha_ini=None, fecha_fin=None) -> Serie:
    """Obtiene datos de una serie individual"""
    params = {"det": det, "tip": tip}
    if nult: params["nult"] = nult
    if fecha_ini and fecha_fin: params["date"] = f"{fecha_ini}:{fecha_fin}"
    elif fecha_ini: params["date"] = f"{fecha_ini}:"
    
    data = _get_json(f"{BASE_TEMPUS3}DATOS_SERIE/{codigo}", params)
    item = data[0] if isinstance(data, list) else data
    return Serie(codigo=item.get("COD",""), nombre=item.get("Nombre",""),
                 unidad=item.get("T3_Unidad",""), datos=item.get("Data",[]))
# ============================================================================
# API JAXI - TABLAS PC-AXIS (.px)
# ============================================================================

def _descargar_px(id_tabla: int, destino: str = None) -> str:
    """Descarga un archivo PC-Axis del INE y lo devuelve como texto"""
    url = f"{BASE_JAXI}files/t/es/px/{id_tabla}.px?nocab=1"
    texto = _get_text(url)
    if destino:
        Path(destino).write_text(texto, encoding=PX_ENCODING)
        logger.info(f"Guardado: {destino}")
    return texto


def _extract(pattern: str, text: str) -> str:
    """Extrae el primer grupo de una regex"""
    m = re.search(pattern, text)
    return m.group(1) if m else ""


def _extraer_valores_dimension(contenido: str) -> Dict[str, List[str]]:
    """
    Extrae las dimensiones y sus valores de un archivo PC-Axis.
    Formato: VALUES("DimName")="val1","val2",...,"valN";
    """
    dims = {}
    # Buscar cada declaración VALUES
    idx = 0
    while True:
        # Buscar VALUES("Nombre")="
        start = contenido.find('VALUES("', idx)
        if start == -1:
            break
        
        # Encontrar el nombre de la dimensión
        paren_start = start + 8  # después de VALUES("
        paren_end = contenido.find('")="', paren_start)
        if paren_end == -1:
            break
        
        nombre_dim = contenido[paren_start:paren_end]
        
        # Posición después de ")="
        after_eq = paren_end + 3  # después de ")="
        # El siguiente carácter debería ser "
        if after_eq >= len(contenido) or contenido[after_eq] != '"':
            idx = after_eq
            continue
        
        # Saltar el primer "
        data_start = after_eq + 1
        
        # Encontrar el ; final
        semic = contenido.find(';', data_start)
        if semic == -1:
            break
        
        bloque = contenido[data_start:semic]
        
        # Extraer valores
        # El bloque tiene formato: 2076","2075","2074",...,"2026
        # (el primer " fue consumido por el regex)
        valores = []
        pos = 0
        while pos < len(bloque):
            c = bloque[pos]
            if c == '"':
                # Buscar la comilla de cierre
                end = bloque.find('"', pos + 1)
                if end == -1:
                    # Ultimo valor (sin comilla de cierre)
                    valor = bloque[pos+1:].strip()
                    if valor:
                        valores.append(valor)
                    break
                valor = bloque[pos+1:end].strip()
                if valor and valor != ',':
                    valores.append(valor)
                pos = end + 1
                # Saltar la coma que sigue (si existe)
                if pos < len(bloque) and bloque[pos] == ',':
                    pos += 1
            elif c == ',':
                # Coma entre valores (después de "2076", viene ,"2075")
                pos += 1
            else:
                # Primer valor (sin comilla inicial): 2076","2075"
                # Leer hasta la siguiente comilla
                end = bloque.find('"', pos)
                if end == -1:
                    valor = bloque[pos:].strip()
                    if valor:
                        valores.append(valor)
                    break
                valor = bloque[pos:end].strip()
                if valor and valor != ',':
                    valores.append(valor)
                pos = end  # dejar pos en la comilla para la siguiente iteración
        
        if valores:
            dims[nombre_dim] = valores
        
        idx = semic + 1
    
    return dims


def parsear_px(contenido: str, archivo: str = "") -> TablaPX:
    """Parsea un archivo PC-Axis (.px) a objeto estructurado"""
    
    # Extraer metadatos básicos
    titulo = _extract(r'TITLE="([^"]*)"', contenido)
    contenido_t = _extract(r'CONTENTS="([^"]*)"', contenido)
    unidad = _extract(r'UNITS="([^"]*)"', contenido)
    dec_str = _extract(r'DECIMALS=(\d+)', contenido)
    decimales = int(dec_str) if dec_str else 0
    
    # Extraer dimensiones
    dims = _extraer_valores_dimension(contenido)
    
    # Extraer datos
    data_match = re.search(r'DATA=([^;]+);', contenido, re.DOTALL)
    datos = []
    if data_match:
        tokens = data_match.group(1).split()
        for t in tokens:
            t = t.strip()
            if t:
                try:
                    datos.append(float(t))
                except ValueError:
                    pass
    
    # Extraer metadatos adicionales
    metadatos = {}
    for m in re.finditer(r'^([A-Z][A-Z_-]+)="([^"]*)"', contenido, re.MULTILINE):
        metadatos[m.group(1)] = m.group(2)
    
    return TablaPX(
        titulo=titulo or "", contenido=contenido_t or "", unidad=unidad or "",
        decimales=decimales, dimensiones=dims, datos=datos,
        metadatos=metadatos, archivo=archivo
    )


def cargar_px(archivo: str) -> TablaPX:
    """Carga un archivo .px desde disco"""
    contenido = Path(archivo).read_text(encoding=PX_ENCODING)
    return parsear_px(contenido, archivo=archivo)


def descargar_tabla_px(id_tabla: int, guardar: bool = False) -> TablaPX:
    """Descarga y parsea una tabla PC-Axis del INE"""
    contenido = _descargar_px(id_tabla, destino=f"t{id_tabla}.px" if guardar else None)
    return parsear_px(contenido, archivo=f"t{id_tabla}.px" if guardar else "")


# ============================================================================
# UTILIDADES PARA TABLAS PX
# ============================================================================

def px_a_serie(tabla: TablaPX) -> Dict[str, List]:
    """Convierte tabla PX unidimensional a dict {clave: [años], valores: [números]}"""
    if not tabla.dimensiones:
        return {"clave": "item", "valores": list(range(len(tabla.datos))), "datos": tabla.datos}
    
    dim_name = list(tabla.dimensiones.keys())[0]
    dim_vals = list(tabla.dimensiones.values())[0]
    
    # Si hay más datos que valores de dimensión, truncar
    n = min(len(dim_vals), len(tabla.datos))
    return {
        "clave": dim_name,
        "valores": dim_vals[:n],
        "datos": tabla.datos[:n]
    }


def px_a_tabla_horizontal(tabla: TablaPX) -> List[Dict[str, Any]]:
    """Convierte tabla PX unidimensional a lista de dicts"""
    serie = px_a_serie(tabla)
    result = []
    for i in range(len(serie["valores"])):
        result.append({
            serie["clave"]: serie["valores"][i],
            "valor": round(serie["datos"][i], tabla.decimales) if tabla.decimales else serie["datos"][i]
        })
    return result


def px_a_dataframe(tabla: TablaPX) -> List[Dict]:
    """
    Convierte una tabla PX multidimensional a lista de diccionarios.
    """
    dims = tabla.dimensiones
    if not dims:
        return [{"valor": v} for v in tabla.datos]
    
    dim_names = list(dims.keys())
    dim_values = list(dims.values())
    
    # Calcular strides para cada dimensión
    total = 1
    for dv in dim_values:
        total *= len(dv)
    
    # El orden de los datos es: última dimensión varía más rápido
    strides = [1]
    for dv in reversed(dim_values):
        strides.insert(0, strides[0] * len(dv))
    strides = strides[1:]  # eliminar el primer elemento extra
    
    rows = []
    for i, val in enumerate(tabla.datos):
        if i >= total:
            break
        row = {}
        remaining = i
        for j, dim_name in enumerate(dim_names):
            dim_size = len(dim_values[j])
            if j < len(dim_names) - 1:
                idx = remaining // strides[j]
                remaining = remaining % strides[j]
            else:
                idx = remaining
            row[dim_name] = dim_values[j][idx]
        row["valor"] = round(val, tabla.decimales) if tabla.decimales else val
        rows.append(row)
    
    return rows


# ============================================================================
# FUNCIONES DE CONSULTA ESPECIALIZADAS
# ============================================================================

def buscar_por_titulo(titulo: str, det=2, geo=0) -> List[Tabla]:
    """Busca tablas cuyo título contenga un texto"""
    todas = []
    for op in listar_operaciones():
        try:
            tabs = listar_tablas(op.codigo, det=det, geo=geo)
            todas.extend(tabs)
        except:
            continue
    t = titulo.lower()
    return [tab for tab in todas if t in tab.nombre.lower()]


def info_tabla(id_tabla: int, formato: str = "texto") -> str:
    """Muestra información formateada de una tabla"""
    px = descargar_tabla_px(id_tabla)
    lineas = [
        "=" * 70,
        f"TABLA {id_tabla}: {px.titulo}",
        f"Contenido: {px.contenido}",
        f"Unidad: {px.unidad}  |  Decimales: {px.decimales}",
        "-" * 70,
    ]
    for dim, vals in px.dimensiones.items():
        lineas.append(f"Dimension '{dim}': {len(vals)} valores ({', '.join(vals[:6])}{'...' if len(vals)>6 else ''})")
    lineas.append(f"Datos: {len(px.datos)} valores")
    
    # Mostrar primeros datos
    filas = px_a_tabla_horizontal(px)
    if filas:
        lineas.append("-" * 70)
        dim_name = list(px.dimensiones.keys())[0] if px.dimensiones else "item"
        lineas.append(f"{dim_name:<18} | Valor")
        lineas.append("-" * 40)
        for f in filas[:10]:
            lineas.append(f"{f.get(dim_name, ''):<18} | {f['valor']}")
        if len(filas) > 10:
            lineas.append(f"... y {len(filas)-10} mas")
    
    lineas.append("=" * 70)
    return "\n".join(lineas)


def resumen_operacion(codigo_op: Union[str,int]) -> str:
    """Muestra resumen de una operacion con sus tablas"""
    op = obtener_operacion(codigo_op)
    tabs = listar_tablas(codigo_op)
    
    lineas = [
        "=" * 70,
        f"OPERACION: {op.get('Nombre','')}",
        f"ID: {op.get('Id','')}  |  Codigo: {op.get('Codigo','')}  |  IOE: {op.get('Cod_IOE','')}",
        f"Tablas disponibles: {len(tabs)}",
        "-" * 70,
    ]
    for t in tabs:
        lineas.append(f"  T{t.id:>5}: {t.nombre}")
    
    return "\n".join(lineas)
# ============================================================================
# ANÁLISIS DE PROYECCIONES DE POBLACIÓN (caso de uso principal)
# ============================================================================

# Tablas predefinidas de Proyecciones de Población (publicación 17/06/2026)
TABLAS_PROP = {
    # Indicadores de Estructura de la Población
    "pob_sexo_edad": 36643,       # Población residente por sexo, edad y año
    "dep_total": 36668,            # Tasa de Dependencia Total
    "dep_menor16": 36669,          # Tasa de Dependencia < 16 años
    "dep_mayor64": 36670,          # Tasa de Dependencia > 64 años
    "envejecimiento": 36667,       # Índice de Envejecimiento
    "edad_media": 36664,           # Edad Media por sexo
    "edad_mediana": 36665,         # Edad Mediana por sexo
    "prop_mayor_edad": 36666,      # Proporción >65, >70, >75...
    
    # Indicadores demográficos
    "tasa_natalidad": 36656,       # Edad Media a la Maternidad
    "tasa_mortalidad": 36657,      # Tasa Bruta de Mortalidad
    "crecimiento": 36660,          # Crecimiento de la Población
    "saldo_vegetativo": 36661,     # Saldo Vegetativo
    "saldo_migratorio": 36662,     # Saldo Migratorio
    "tasa_inmigracion": 36671,     # Tasa Bruta de Inmigración
    "tasa_emigracion": 36673,      # Tasa Bruta de Emigración
}


def analisis_dependencia(mostrar_todas: bool = True) -> str:
    """
    Análisis completo de la proyección de dependientes en España 2026-2076.
    
    Args:
        mostrar_todas: Si True, muestra todos los años; si False, solo años clave
    """
    # Cargar datos
    px_dep = descargar_tabla_px(TABLAS_PROP["dep_total"])
    px_u16 = descargar_tabla_px(TABLAS_PROP["dep_menor16"])
    px_o64 = descargar_tabla_px(TABLAS_PROP["dep_mayor64"])
    px_envej = descargar_tabla_px(TABLAS_PROP["envejecimiento"])
    
    # Convertir a formato tabular
    dep_t = px_a_serie(px_dep)
    dep_u = px_a_serie(px_u16)
    dep_o = px_a_serie(px_o64)
    envej = px_a_serie(px_envej)
    
    # Años seleccionados
    if mostrar_todas:
        anios = dep_t["valores"]
    else:
        anios = [a for a in dep_t["valores"] if a in 
                 {'2026','2030','2035','2040','2045','2050','2055','2060','2065','2070','2075','2076'}]
    
    # Construir tabla
    lineas = [
        "=" * 80,
        "PROYECCIONES DE POBLACION - INE 2026-2076",
        "Tasas de Dependencia e Índice de Envejecimiento",
        f"Fuente: INE - Proyecciones de Población (publicado: 17/06/2026)",
        "=" * 80,
        f"{'Año':<6} {'Dep. Total':<12} {'<16 años':<12} {'>64 años':<12} {'Envejec.':<12}",
        "-" * 80,
    ]
    
    for i, anio in enumerate(dep_t["valores"]):
        if anio in anios:
            idx = dep_t["valores"].index(anio)
            lineas.append(
                f"{anio:<6} {dep_t['datos'][idx]:>8.2f}%    "
                f"{dep_u['datos'][idx]:>6.2f}%    "
                f"{dep_o['datos'][idx]:>6.2f}%    "
                f"{envej['datos'][idx]:>7.2f}"
            )
    
    # Conclusiones
    d2026 = dep_t['datos'][dep_t['valores'].index('2026')]
    d2076 = dep_t['datos'][dep_t['valores'].index('2076')]
    o2026 = dep_o['datos'][dep_t['valores'].index('2026')]
    o2076 = dep_o['datos'][dep_t['valores'].index('2076')]
    u2026 = dep_u['datos'][dep_t['valores'].index('2026')]
    u2076 = dep_u['datos'][dep_t['valores'].index('2076')]
    e2026 = envej['datos'][dep_t['valores'].index('2026')]
    e2076 = envej['datos'][dep_t['valores'].index('2076')]
    
    lineas.extend([
        "-" * 80,
        "CONCLUSIONES:",
        f"  - Tasa de dependencia total: {d2026:.2f}% (2026) -> {d2076:.2f}% (2076)",
        f"    Incremento: {d2076 - d2026:+.2f} puntos porcentuales",
        f"  - Dependencia infantil (<16): {u2026:.2f}% -> {u2076:.2f}% (estable)",
        f"  - Dependencia mayores (>64): {o2026:.2f}% -> {o2076:.2f}% (se dispara)",
        f"  - Índice de envejecimiento: {e2026:.0f} -> {e2076:.0f} (x{e2076/e2026:.1f})",
        f"  - En 2076 habrá {e2076/e2026:.1f} veces más mayores que niños que en 2026",
        "=" * 80,
    ])
    
    return "\n".join(lineas)


# ============================================================================
# CLI - INTERFAZ DE LÍNEA DE COMANDOS
# ============================================================================

def cli():
    """Interfaz interactiva por terminal"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Cliente API del INE - Instituto Nacional de Estadística",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Ejemplos:
  %(prog)s ops                    # Listar todas las operaciones
  %(prog)s buscar IPC             # Buscar operaciones con 'IPC'
  %(prog)s op IPCA                # Resumen de operación IPCA
  %(prog)s tablas 25              # Tablas de la operación IPC (id=25)
  %(prog)s tabla 36668            # Info de la tabla 36668 (Tasa Dependencia)
  %(prog)s datos 36668            # Datos completos de la tabla 36668
  %(prog)s dependencia            # Análisis de proyección de dependientes
  %(prog)s dependencia --todas    # Todos los años, no solo clave
        """
    )
    
    parser.add_argument("comando", nargs="?", help="Comando: ops, buscar, op, tablas, tabla, datos, dependencia")
    parser.add_argument("argumento", nargs="?", help="Argumento del comando")
    parser.add_argument("--todas", action="store_true", help="Mostrar todos los años")
    parser.add_argument("--json", action="store_true", help="Salida JSON")
    
    args = parser.parse_args()
    
    if not args.comando:
        parser.print_help()
        return
    
    cmd = args.comando.lower()
    
    try:
        if cmd == "ops":
            ops = listar_operaciones()
            print(f"\nTotal: {len(ops)} operaciones\n")
            for op in ops:
                print(op)
                
        elif cmd == "buscar":
            if not args.argumento:
                print("Error: necesita un término de búsqueda")
                return
            ops = buscar_operacion(args.argumento)
            print(f"\n'{args.argumento}': {len(ops)} resultados\n")
            for op in ops:
                print(op)
                
        elif cmd == "op":
            if not args.argumento:
                print("Error: necesita código de operación")
                return
            print(resumen_operacion(args.argumento))
            
        elif cmd == "tablas":
            if not args.argumento:
                print("Error: necesita código de operación")
                return
            tabs = listar_tablas(args.argumento)
            print(f"\nTablas de operación {args.argumento}: {len(tabs)}\n")
            for t in tabs:
                print(t)
                
        elif cmd == "tabla":
            if not args.argumento:
                print("Error: necesita ID de tabla")
                return
            print(info_tabla(int(args.argumento)))
            
        elif cmd == "datos":
            if not args.argumento:
                print("Error: necesita ID de tabla")
                return
            px = descargar_tabla_px(int(args.argumento))
            filas = px_a_tabla_horizontal(px)
            dim_name = list(px.dimensiones.keys())[0] if px.dimensiones else "item"
            print(f"\n{px.titulo}\n{'='*60}")
            print(f"Unidad: {px.unidad}  |  {len(filas)} registros\n")
            for f in filas:
                print(f"{f.get(dim_name,''):<20} {f['valor']}")
                
        elif cmd == "dependencia":
            print(analisis_dependencia(mostrar_todas=args.todas))
            
        else:
            print(f"Comando desconocido: {cmd}")
            parser.print_help()
            
    except Exception as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        sys.exit(1)


# ============================================================================
# MAIN
# ============================================================================
if __name__ == "__main__":
    if len(sys.argv) > 1:
        cli()
    else:
        # Demo: análisis de dependencia
        print(analisis_dependencia(mostrar_todas=False))
