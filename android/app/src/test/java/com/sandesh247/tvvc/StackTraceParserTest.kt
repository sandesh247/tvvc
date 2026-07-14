package com.sandesh247.tvvc

import org.junit.Assert.*
import org.junit.Test

class StackTraceParserTest {

    // Helper to run the exact parsing logic from MainActivity.kt
    private fun parseStackTrace(stackTrace: String): List<StackTraceElement> {
        val lines = stackTrace.split("\n")
        return lines.mapNotNull { line ->
            try {
                val trimmed = line.trim()
                if (trimmed.startsWith("at ")) {
                    val content = trimmed.substring(3)
                    val hasOpen = content.contains('(')
                    val hasClose = content.contains(')')
                    if ((hasOpen && !hasClose) || (!hasOpen && hasClose)) {
                        null
                    } else {
                        val parenStart = content.indexOf('(')
                        val parenEnd = content.indexOf(')')
                        if (hasOpen && hasClose && parenEnd < parenStart) {
                            null
                        } else {
                            val (func, filePart) = if (parenStart != -1 && parenEnd != -1) {
                                Pair(content.substring(0, parenStart).trim(), content.substring(parenStart + 1, parenEnd).trim())
                            } else {
                                Pair("anonymous", content)
                            }
                            val parts = filePart.split(":")
                            if (parts.size >= 2) {
                                val lineNumber = parts[parts.size - 2].toIntOrNull() ?: 0
                                val fileName = parts.subList(0, parts.size - 2).joinToString(":").substringAfterLast("/")
                                val cleanFileName = fileName.trim()
                                if (cleanFileName.isNotBlank() && !cleanFileName.contains('(') && !cleanFileName.contains(')') && !cleanFileName.contains(':') && !cleanFileName.contains('[') && !cleanFileName.contains(']')) {
                                    StackTraceElement("JavaScript", func, cleanFileName, lineNumber)
                                } else {
                                    null
                                }
                            } else {
                                null
                            }
                        }
                    }
                } else {
                    null
                }
            } catch (e: Exception) {
                null
            }
        }
    }

    @Test
    fun testEmptyStackTrace() {
        val elements = parseStackTrace("")
        assertTrue(elements.isEmpty())
    }

    @Test
    fun testMalformedStackTraceNoAt() {
        val elements = parseStackTrace("some random error message\nline 2 without at prefix")
        assertTrue(elements.isEmpty())
    }

    @Test
    fun testStandardStackTrace() {
        val stack = """
            Error: Something went wrong
                at onClick (http://localhost:3000/src/App.tsx:42:15)
                at HTMLButtonElement.dispatchEvent (http://localhost:3000/node_modules/react-dom/index.js:100:5)
        """.trimIndent()
        val elements = parseStackTrace(stack)
        assertEquals(2, elements.size)
        
        assertEquals("onClick", elements[0].methodName)
        assertEquals("App.tsx", elements[0].fileName)
        assertEquals(42, elements[0].lineNumber)
        assertEquals("JavaScript", elements[0].className)

        assertEquals("HTMLButtonElement.dispatchEvent", elements[1].methodName)
        assertEquals("index.js", elements[1].fileName)
        assertEquals(100, elements[1].lineNumber)
    }

    @Test
    fun testAnonymousStackTrace() {
        val stack = "at http://localhost:3000/src/App.tsx:42:15"
        val elements = parseStackTrace(stack)
        assertEquals(1, elements.size)
        assertEquals("anonymous", elements[0].methodName)
        assertEquals("App.tsx", elements[0].fileName)
        assertEquals(42, elements[0].lineNumber)
    }

    @Test
    fun testMissingLineNumbers() {
        val stack = "at onClick (http://localhost:3000/src/App.tsx)"
        val elements = parseStackTrace(stack)
        assertEquals(1, elements.size)
        assertEquals("onClick", elements[0].methodName)
        assertEquals("http", elements[0].fileName)
        assertEquals(0, elements[0].lineNumber)
    }

    @Test
    fun testInvalidLineNumberFormat() {
        val stack = "at onClick (http://localhost:3000/src/App.tsx:abc:15)"
        val elements = parseStackTrace(stack)
        assertEquals(1, elements.size)
        assertEquals("onClick", elements[0].methodName)
        assertEquals("App.tsx", elements[0].fileName)
        assertEquals(0, elements[0].lineNumber)
    }

    @Test
    fun testExtremelyMalformed() {
        val stack = "at \nat (\nat (:\nat (::\nat (:::"
        val elements = parseStackTrace(stack)
        assertTrue(elements.isEmpty())
    }
}
